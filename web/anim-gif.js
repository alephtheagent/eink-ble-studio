// Minimal, dependency-free GIF87a/89a decoder for the animation panel.
//
// Scope: logical screen, global/local colour tables, LZW, interlace, graphic
// control extensions (delay, transparent index, disposal 0/1/2/3), multi-frame
// compositing, and one full logical-screen RGBA buffer per displayed frame.
// No DOM, no createImageBitmap/ImageDecoder: callers pass bytes, so the same
// code runs in node tests and in browsers that lack ImageDecoder.
//
// Delay semantics: a graphic control extension stores delay in centiseconds.
// 1 cs is 10 ms. A delay of 0 ("as fast as possible") is reported as 100 ms,
// matching the browser convention documented by the WHATWG HTML image
// decoding rules and implemented by Chrome/Firefox/Safari. The raw value is
// always exposed as `rawDelayMs` (0) so the UI can warn instead of silently
// pretending the file asked for 100 ms.

export const GIF_MAX_FRAMES = 64;
// A GIF asked to display a frame faster than the e-ink panel can refresh is
// held at this floor by the preview and the wire delay. The raw delay is kept.
export const GIF_FLOOR_DELAY_MS = 100;
export const GIF_MIN_DELAY_MS = 100;
export const GIF_MAX_DELAY_MS = 60000;
export const GIF_MAX_PIXELS = 16_000_000;

export class GifError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GifError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new GifError(code, message); };

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  fail('not-gif', 'GIF data must be a byte array');
}

// Reads the sub-block chain (length byte + payload, terminated by 0x00).
function readSubBlocks(bytes, state) {
  const chunks = [];
  let total = 0;
  for (;;) {
    if (state.pos >= bytes.length) fail('truncated', 'GIF ended inside a data sub-block');
    const size = bytes[state.pos++];
    if (size === 0) break;
    if (state.pos + size > bytes.length) fail('truncated', 'GIF data sub-block runs past the end of the file');
    chunks.push(bytes.subarray(state.pos, state.pos + size));
    total += size;
    state.pos += size;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function readColorTable(bytes, state, size) {
  const needed = size * 3;
  if (state.pos + needed > bytes.length) fail('truncated', 'GIF colour table runs past the end of the file');
  const table = new Uint8Array(needed);
  table.set(bytes.subarray(state.pos, state.pos + needed));
  state.pos += needed;
  return table;
}

const tableSize = packed => 2 << (packed & 7);

function deinterlaceRows(height) {
  // GIF interlace order: every 8th row from 0, every 8th from 4, every 4th
  // from 2, every 2nd from 1. Returns destination row numbers in stream order.
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

const LZW_MAX_CODES = 4096;

function lzwDecode(minCodeSize, data, expectedPixels) {
  if (minCodeSize < 2 || minCodeSize > 8) fail('lzw', `Invalid GIF LZW minimum code size ${minCodeSize}`);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const prefix = new Int32Array(LZW_MAX_CODES).fill(-1);
  const suffix = new Uint8Array(LZW_MAX_CODES);
  const firstByte = new Uint8Array(LZW_MAX_CODES);
  for (let i = 0; i < clearCode; i++) { suffix[i] = i; firstByte[i] = i; }
  const out = new Uint8Array(expectedPixels);
  const stack = new Uint8Array(LZW_MAX_CODES);
  let outPos = 0, codeSize = minCodeSize + 1, nextCode = eoiCode + 1;
  let previous = -1, bitBuffer = 0, bitCount = 0, bytePos = 0;

  for (;;) {
    while (bitCount < codeSize) {
      if (bytePos >= data.length) {
        // End of stream. A frame is complete when every pixel was produced;
        // otherwise the file lied about its image size.
        if (outPos < expectedPixels) fail('truncated', `GIF LZW stream ended after ${outPos} of ${expectedPixels} pixels`);
        return out;
      }
      bitBuffer |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      previous = -1;
      continue;
    }
    if (code === eoiCode) {
      if (outPos < expectedPixels) fail('truncated', `GIF LZW stream ended early (${outPos} of ${expectedPixels} pixels)`);
      return out;
    }
    if (previous === -1) {
      if (code >= clearCode) fail('lzw', `Invalid GIF LZW code ${code} before any pixel code`);
      out[outPos++] = code;
      previous = code;
      continue;
    }
    if (code > nextCode) fail('lzw', `Invalid GIF LZW code ${code}; next available code is ${nextCode}`);

    // Build the string for this code on a stack (bottom = first byte) and pop.
    let walk = code >= nextCode ? previous : code, top = 0;
    if (code >= nextCode) stack[top++] = firstByte[previous]; // KwKwK: string(prev) + first(prev)
    let guard = 0;
    while (walk >= clearCode) {
      stack[top++] = suffix[walk];
      walk = prefix[walk];
      if (++guard > LZW_MAX_CODES) fail('lzw', 'Cyclic GIF LZW dictionary');
    }
    stack[top++] = walk;
    if (outPos + top > expectedPixels) fail('lzw', 'GIF LZW stream produced more pixels than the image size');
    while (top > 0) out[outPos++] = stack[--top];

    const appended = code >= nextCode ? firstByte[previous] : firstByte[code];
    if (nextCode < LZW_MAX_CODES) {
      prefix[nextCode] = previous;
      suffix[nextCode] = appended;
      firstByte[nextCode] = firstByte[previous];
      nextCode++;
      // A full dictionary waits for the encoder's clear code and keeps 12-bit
      // codes; compressors that never clear are legal and accepted.
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    previous = code;
    if (outPos >= expectedPixels) return out;
  }
}

// Optional NETSCAPE/ANIMEXTS loop extension. Returns null when absent.
function readLoopExtension(bytes, state) {
  // Layout: 0x21 0xFF, blockSize (11), 8-byte identifier, 3-byte auth code,
  // then data sub-blocks. state.pos points at the blockSize byte.
  if (state.pos + 12 > bytes.length) fail('truncated', 'GIF application extension is truncated');
  const blockSize = bytes[state.pos];
  if (blockSize !== 11) fail('malformed', `GIF application extension has block size ${blockSize}`);
  const identifier = String.fromCharCode(...bytes.subarray(state.pos + 1, state.pos + 4));
  state.pos += 12;
  if (identifier !== 'NET' && identifier !== 'ANI') { readSubBlocks(bytes, state); return null; }
  const data = readSubBlocks(bytes, state);
  if (data.length >= 3 && data[0] === 1) return data[1] | (data[2] << 8);
  return null;
}

export function decodeGif(input, { maxFrames = GIF_MAX_FRAMES } = {}) {
  const bytes = asBytes(input);
  if (bytes.length < 13) fail('not-gif', 'File is too short to be a GIF');
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') fail('not-gif', 'Not a GIF87a or GIF89a file');
  const version = signature.slice(3);
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (!width || !height) fail('not-gif', 'GIF logical screen has a zero dimension');
  if (width * height > GIF_MAX_PIXELS) fail('not-gif', `GIF logical screen ${width}×${height} is too large`);

  const packed = bytes[10];
  const backgroundIndex = bytes[11];
  const state = { pos: 13 };
  const globalTable = packed & 0x80 ? readColorTable(bytes, state, tableSize(packed)) : null;
  const background = (() => {
    if (!globalTable || backgroundIndex * 3 + 2 >= globalTable.length) return [0, 0, 0, 0];
    return [globalTable[backgroundIndex * 3], globalTable[backgroundIndex * 3 + 1], globalTable[backgroundIndex * 3 + 2], 255];
  })();

  const canvas = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4] = background[0];
    canvas[i * 4 + 1] = background[1];
    canvas[i * 4 + 2] = background[2];
    canvas[i * 4 + 3] = background[3];
  }

  const frames = [];
  let loopCount = null;
  let gce = null; // pending graphic control extension
  let compat = null; // previous-frame snapshot for disposal 3

  for (;;) {
    if (state.pos >= bytes.length) {
      if (!frames.length) fail('truncated', 'GIF contains no image frames');
      break; // Some encoders omit the trailing 0x3B byte.
    }
    const introducer = bytes[state.pos++];
    if (introducer === 0x3b) {
      if (!frames.length) fail('truncated', 'GIF contains no image frames');
      break;
    }
    if (introducer === 0x21) {
      if (state.pos >= bytes.length) fail('truncated', 'GIF extension block is truncated');
      const label = bytes[state.pos++];
      if (label === 0xf9) {
        const blockSize = bytes[state.pos];
        if (blockSize !== 4) fail('malformed', `GIF graphic control extension has block size ${blockSize}`);
        if (state.pos + 6 > bytes.length) fail('truncated', 'GIF graphic control extension is truncated');
        const flags = bytes[state.pos + 1];
        const delayCs = bytes[state.pos + 2] | (bytes[state.pos + 3] << 8);
        const transparent = bytes[state.pos + 4];
        if (bytes[state.pos + 5] !== 0) fail('malformed', 'GIF graphic control extension is not terminated');
        state.pos += 6;
        const disposal = (flags >> 2) & 7;
        if (disposal === 4 || disposal === 5 || disposal === 6 || disposal === 7) fail('malformed', `Unsupported GIF disposal method ${disposal}`);
        gce = { disposal, transparentIndex: flags & 1 ? transparent : -1, delayCs };
        continue;
      }
      if (label === 0xff) {
        const value = readLoopExtension(bytes, state);
        if (value !== null) loopCount = value;
        continue;
      }
      // Comment (0xFE), plain text (0x01) and unknown extensions are skipped.
      readSubBlocks(bytes, state);
      continue;
    }
    if (introducer !== 0x2c) fail('malformed', `Unknown GIF block introducer 0x${introducer.toString(16)}`);

    if (state.pos + 9 > bytes.length) fail('truncated', 'GIF image descriptor is truncated');
    const left = bytes[state.pos] | (bytes[state.pos + 1] << 8);
    const top = bytes[state.pos + 2] | (bytes[state.pos + 3] << 8);
    const fw = bytes[state.pos + 4] | (bytes[state.pos + 5] << 8);
    const fh = bytes[state.pos + 6] | (bytes[state.pos + 7] << 8);
    const imagePacked = bytes[state.pos + 8];
    state.pos += 9;
    if (!fw || !fh) fail('malformed', 'GIF image frame has a zero dimension');
    if (left + fw > width || top + fh > height) fail('malformed', 'GIF image frame lies outside the logical screen');
    const localTable = imagePacked & 0x80 ? readColorTable(bytes, state, tableSize(imagePacked)) : null;
    const palette = localTable || globalTable;
    if (!palette) fail('malformed', 'GIF image frame has no colour table');
    const interlaced = !!(imagePacked & 0x40);
    if (state.pos >= bytes.length) fail('truncated', 'GIF image data is truncated');
    const minCodeSize = bytes[state.pos++];
    const compressed = readSubBlocks(bytes, state);
    if (frames.length >= maxFrames) {
      const error = new GifError('frame-limit', `Animated GIF has more than ${maxFrames} frames (limit ${maxFrames})`);
      error.count = frames.length + 1;
      error.max = maxFrames;
      throw error;
    }

    const indices = lzwDecode(minCodeSize, compressed, fw * fh);
    const frameInfo = gce || { disposal: 0, transparentIndex: -1, delayCs: 0 };
    if (frameInfo.disposal === 3) compat = canvas.slice();
    const transparentIndex = frameInfo.transparentIndex;
    const rows = interlaced ? deinterlaceRows(fh) : null;
    for (let rowIndex = 0; rowIndex < fh; rowIndex++) {
      const sourceRow = rows ? rows[rowIndex] : rowIndex;
      const destRow = top + sourceRow;
      for (let x = 0; x < fw; x++) {
        const index = indices[rowIndex * fw + x];
        if (index === transparentIndex) continue;
        if (index * 3 + 2 >= palette.length) fail('malformed', `GIF colour index ${index} is outside the colour table`);
        const di = (destRow * width + left + x) * 4;
        canvas[di] = palette[index * 3];
        canvas[di + 1] = palette[index * 3 + 1];
        canvas[di + 2] = palette[index * 3 + 2];
        canvas[di + 3] = 255;
      }
    }

    const rawDelayMs = Math.min(frameInfo.delayCs * 10, 0xffff * 10);
    frames.push({
      // One full logical-screen RGBA snapshot per displayed frame.
      rgba: canvas.slice(),
      left, top, width: fw, height: fh,
      delayCs: frameInfo.delayCs,
      rawDelayMs,
      delayMs: rawDelayMs === 0 ? GIF_FLOOR_DELAY_MS : rawDelayMs,
      disposal: frameInfo.disposal,
      transparentIndex
    });

    if (frameInfo.disposal === 2) {
      for (let y = top; y < top + fh; y++) for (let x = left; x < left + fw; x++) {
        const di = (y * width + x) * 4;
        canvas[di] = background[0]; canvas[di + 1] = background[1]; canvas[di + 2] = background[2]; canvas[di + 3] = background[3];
      }
    } else if (frameInfo.disposal === 3 && compat) {
      canvas.set(compat);
      compat = null;
    }
    gce = null;
  }

  return { version, width, height, background, loopCount, frames };
}
