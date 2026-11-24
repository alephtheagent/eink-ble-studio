#!/usr/bin/env node
// Genuine GIF89a fixture generator: a real LZW encoder plus an independent
// decoder used as ground truth. No network, no external tools.
//
//   node tests/fixtures/animation/make-gif.mjs          # write the fixtures
//   node tests/fixtures/animation/make-gif.mjs --check  # fail if committed files differ
//
// Pipeline (documented in docs/protocol-animation.md): the encoder paints the
// index frames below, writes sample.gif, then the decoder re-reads those exact
// bytes, composites with GIF disposal rules, converts to 122x250 1-bit frames with
//   luminance = round(0.299R + 0.587G + 0.114B), transparent composited over white,
//   black when luminance < 128, stride 16, 1 = black
// and writes frames.json with each blob (web/anim-codec.js) and each expected
// 4000-byte frame. A GIF decoder that implements disposal 2 as "clear to the
// logical background colour" or as "clear to transparent" produces identical
// 1-bit frames here, because the background is opaque white and transparency is
// composited over white.
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FRAME_BYTES, WIDTH, HEIGHT } from '../../../web/anim-codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUTPUT = {
  gif: join(HERE, 'sample.gif'),
  unsupported: join(HERE, 'unsupported.gif'),
  frames: join(HERE, 'frames.json'),
};

export const PALETTE = [
  [255, 255, 255], // 0 background / white
  [0, 0, 0],       // 1 black
  [96, 96, 96],    // 2 mid grey (still below the 128 threshold: black)
  [200, 200, 200], // 3 transparent colour entry (never painted)
];
const TRANSPARENT = 3;

const mulberry32 = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------- LZW encoder
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.bits = 0; }
  write(code, size) {
    this.acc |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) { this.bytes.push(this.acc & 0xff); this.acc >>>= 8; this.bits -= 8; }
    // Codes are at most 12 bits; keep the accumulator small and exact.
    this.acc &= (1 << this.bits) - 1;
  }
  finish() { if (this.bits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.bits = 0; } return this.bytes; }
}

export function lzwEncode(indices, minCodeSize = 2) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out = new BitWriter();
  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;
  const dict = new Map();
  const reset = () => { dict.clear(); codeSize = minCodeSize + 1; nextCode = eoi + 1; };
  out.write(clear, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    out.write(prefix, codeSize);
    if (nextCode < 4096) {
      // The code about to be assigned must fit the current width, so the width
      // grows before the entry is added (matches giflib/Pillow).
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      dict.set(key, nextCode++);
    } else {
      out.write(clear, codeSize);
      reset();
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  out.write(eoi, codeSize);
  return Uint8Array.from(out.finish());
}

// ---------------------------------------------------------------- GIF writer
const u16 = n => [n & 0xff, (n >>> 8) & 0xff];
const subBlocks = data => {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
};

function gifHeader(width, height, palette, bgIndex) {
  if (palette.length !== 4) throw new Error('this fixture generator writes a 4-entry global colour table');
  const bytes = [...'GIF89a'.split('').map(c => c.charCodeAt(0))];
  bytes.push(...u16(width), ...u16(height), 0x80 | 0x70 | 1, bgIndex, 0);
  for (const [r, g, b] of palette) bytes.push(r, g, b);
  // NETSCAPE2.0 looping extension, loop count 0 = forever.
  bytes.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  return bytes;
}

function gifFrame(rect, indices, { delayCs, disposal, transparent, interlaced }) {
  const [left, top, width, height] = rect;
  if (indices.length !== width * height) throw new Error('frame index buffer does not match its rectangle');
  const packed = (disposal & 7) << 2 | (transparent ? 1 : 0);
  const bytes = [0x21, 0xf9, 4, packed, ...u16(delayCs), transparent ? TRANSPARENT : 0, 0];
  bytes.push(0x2c, ...u16(left), ...u16(top), ...u16(width), ...u16(height), interlaced ? 0x40 : 0);
  const minCodeSize = 2;
  bytes.push(minCodeSize, ...subBlocks(lzwEncode(indices, minCodeSize)));
  return bytes;
}

const writeGif = (width, height, frames, palette = PALETTE, bgIndex = 0) =>
  Uint8Array.from([...gifHeader(width, height, palette, bgIndex),
    ...frames.flatMap(f => gifFrame(f.rect, f.indices, f)), 0x3b]);

// ---------------------------------------------------------------- GIF decoder
class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  need(n) { if (this.pos + n > this.bytes.length) throw new Error(`truncated GIF at byte ${this.pos}`); }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  u16() { this.need(2); const v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8); this.pos += 2; return v; }
  take(n) { this.need(n); const s = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  subBlocks() {
    const parts = [];
    for (;;) {
      const n = this.u8();
      if (!n) return Buffer.concat(parts);
      parts.push(Buffer.from(this.take(n)));
    }
  }
}

function lzwDecode(data, minCodeSize, expected) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1, next = eoi + 1;
  for (let i = 0; i < clear; i++) { suffix[i] = i; first[i] = i; }
  const out = new Uint8Array(expected);
  let produced = 0, bitPos = 0, prev = -1;
  const readCode = () => {
    let value = 0, bits = 0;
    while (bits < codeSize) {
      const byte = bitPos >> 3;
      if (byte >= data.length) return -1;
      value |= ((data[byte] >> (bitPos & 7)) & 1) << bits;
      bitPos++; bits++;
    }
    return value;
  };
  for (;;) {
    let code = readCode();
    if (code < 0) throw new Error('LZW stream ended before EOI');
    if (code === clear) {
      codeSize = minCodeSize + 1; next = eoi + 1; prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev < 0) {
      if (code >= clear) throw new Error('first LZW code after clear is not a literal');
      if (produced >= expected) throw new Error('LZW output exceeds the frame rectangle');
      out[produced++] = suffix[code]; prev = code; continue;
    }
    let current = code, sp = 0;
    if (code >= next) {
      if (code !== next) throw new Error('LZW code is outside the dictionary');
      stack[sp++] = first[prev]; current = prev; // KwKwK
    }
    while (current >= clear) {
      if (sp > 4096) throw new Error('LZW dictionary chain is cyclic');
      stack[sp++] = suffix[current]; current = prefix[current];
    }
    stack[sp++] = suffix[current];
    if (next < 4096) { prefix[next] = prev; suffix[next] = stack[sp - 1]; first[next] = first[prev]; next++; }
    while (sp > 0) {
      if (produced >= expected) throw new Error('LZW output exceeds the frame rectangle');
      out[produced++] = stack[--sp];
    }
    prev = code;
    // Encoder and decoder add the same entry per code, so both grow at the same
    // point: once the next free index equals the current code space.
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
  }
  if (produced !== expected) throw new Error(`LZW produced ${produced} of ${expected} pixels`);
  return out;
}

const deinterlace = (rows, width, height) => {
  const out = new Uint8Array(width * height);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let source = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      out.set(rows.subarray(source, source + width), y * width);
      source += width;
    }
  }
  if (source !== width * height) throw new Error('interlace pass count mismatch');
  return out;
};

// Returns [{ rgba, delayMs, disposal, transparent, interlaced, rect }].
export function decodeGif(bytes) {
  const r = new Reader(bytes);
  const signature = Buffer.from(r.take(6)).toString('latin1');
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new Error(`not a GIF: ${JSON.stringify(signature)}`);
  const width = r.u16(), height = r.u16();
  const packed = r.u8(), bgIndex = r.u8();
  r.u8(); // pixel aspect ratio
  if (!width || !height) throw new Error('GIF has an empty logical screen');
  let global = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 7);
    global = r.take(size * 3);
  }
  const colorOf = (table, index) => table
    ? [table[index * 3], table[index * 3 + 1], table[index * 3 + 2]]
    : PALETTE[index] || [0, 0, 0];
  const background = global ? colorOf(global, bgIndex) : [255, 255, 255];

  const canvas = new Uint8Array(width * height * 4);
  const clearTo = (rect, rgb) => {
    const [left, top, w, h] = rect;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((top + y) * width + left + x) * 4;
      canvas[i] = rgb[0]; canvas[i + 1] = rgb[1]; canvas[i + 2] = rgb[2]; canvas[i + 3] = 255;
    }
  };
  clearTo([0, 0, width, height], background);

  const frames = [];
  let gce = { delayCs: 0, disposal: 0, transparent: false, transparentIndex: -1 };
  let saved = null;
  for (;;) {
    const introducer = r.u8();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = r.u8();
      if (label === 0xf9) {
        const size = r.u8();
        if (size !== 4) throw new Error('malformed graphic control extension');
        const flags = r.u8(), delayCs = r.u16(), tIndex = r.u8();
        if (r.u8() !== 0) throw new Error('graphic control extension is not terminated');
        gce = { delayCs, disposal: (flags >> 2) & 7, transparent: !!(flags & 1), transparentIndex: flags & 1 ? tIndex : -1 };
      } else {
        r.subBlocks();
      }
      continue;
    }
    if (introducer !== 0x2c) throw new Error(`unknown GIF block 0x${introducer.toString(16)} at byte ${r.pos - 1}`);
    const left = r.u16(), top = r.u16(), w = r.u16(), h = r.u16();
    const flags = r.u8();
    if (left + w > width || top + h > height) throw new Error('image rectangle exceeds the logical screen');
    const table = flags & 0x80 ? r.take((2 << (flags & 7)) * 3) : global;
    const interlaced = !!(flags & 0x40);
    const minCodeSize = r.u8();
    if (minCodeSize < 2 || minCodeSize > 8) throw new Error(`invalid LZW minimum code size ${minCodeSize}`);
    const pixels = lzwDecode(r.subBlocks(), minCodeSize, w * h);
    const rows = interlaced ? deinterlace(pixels, w, h) : pixels;
    if (gce.disposal === 3) saved = Uint8Array.from(canvas);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const index = rows[y * w + x];
      if (gce.transparent && index === gce.transparentIndex) continue;
      const rgb = colorOf(table, index);
      const i = ((top + y) * width + left + x) * 4;
      canvas[i] = rgb[0]; canvas[i + 1] = rgb[1]; canvas[i + 2] = rgb[2]; canvas[i + 3] = 255;
    }
    frames.push({ rgba: Uint8Array.from(canvas), delayMs: gce.delayCs * 10, disposal: gce.disposal,
      transparent: gce.transparent, interlaced, rect: [left, top, w, h] });
    if (gce.disposal === 2) clearTo([left, top, w, h], background);
    else if (gce.disposal === 3 && saved) { canvas.set(saved); saved = null; }
    gce = { delayCs: 0, disposal: 0, transparent: false, transparentIndex: -1 };
  }
  if (r.pos !== bytes.length) throw new Error(`${bytes.length - r.pos} trailing bytes after the GIF trailer`);
  if (!frames.length) throw new Error('GIF contains no frames');
  return { width, height, background, frames };
}

// ---------------------------------------------------- 1-bit frame conversion
export function frameFromRGBA(rgba, width = WIDTH, height = HEIGHT) {
  const stride = Math.ceil(width / 8);
  const frame = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const alpha = rgba[i + 3] / 255;
    const luminance = Math.round((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * alpha + 255 * (1 - alpha));
    if (luminance < 128) frame[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return frame;
}

// ------------------------------------------------------------- fixture model
// Frame 0: full-canvas split, disposal 1 (leave in place).
// Frame 1: checkered block with transparent holes, disposal 2 (restore background).
// Frame 2: interlaced patterned block, disposal 1.
// Frame 3: transparent disc inside a patterned band, disposal 2.
function fixtureFrames(width, height) {
  const full = (w, h, f) => { const out = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y); return out; };
  return [
    { rect: [0, 0, width, height], delayCs: 12, disposal: 1, transparent: false, interlaced: false,
      indices: full(width, height, (x, y) => (x < width >> 1) !== (y < height >> 1) ? 1 : 0) },
    { rect: [20, 30, 40, 40], delayCs: 10, disposal: 2, transparent: true, interlaced: false,
      indices: full(40, 40, (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? TRANSPARENT : (x + y) % 5 === 0 ? 2 : 1) },
    { rect: [60, 120, 50, 60], delayCs: 25, disposal: 1, transparent: false, interlaced: true,
      indices: full(50, 60, (x, y) => { const v = (x * 7 + y * 3) % 13; return v < 5 ? 1 : v < 9 ? 2 : 0; }) },
    { rect: [0, 200, width, 50], delayCs: 33, disposal: 2, transparent: true, interlaced: false,
      indices: full(width, 50, (x, y) => {
        const dx = x - (width >> 1), dy = y - 25;
        if (dx * dx + dy * dy < 256) return TRANSPARENT;
        return (x >> 3) % 3 === 0 ? 2 : 1;
      }) },
  ];
}

export function buildFixtures() {
  const frames = fixtureFrames(WIDTH, HEIGHT);
  const gif = writeGif(WIDTH, HEIGHT, frames);
  const truncated = gif.subarray(0, Math.floor(gif.length * 0.3));
  const decoded = decodeGif(gif);
  // The decoder must reproduce the painted model: encode/decode round trip.
  const expectedFrames = [];
  let prev = null;
  for (const [index, frame] of decoded.frames.entries()) {
    const bits = frameFromRGBA(frame.rgba);
    const encoded = encodeFrame(prev, bits);
    expectedFrames.push({
      index, delayMs: frame.delayMs,
      disposal: frames[index].disposal, transparent: frame.transparent, interlaced: frame.interlaced,
      rect: frame.rect, kind: encoded.kind, encLen: encoded.encLen,
      frameCrc: readCrc(bits), frameHex: Buffer.from(bits).toString('hex'),
      blobHex: Buffer.from(encoded.blob).toString('hex'),
    });
    prev = bits;
  }
  return { gif, truncated, frames: expectedFrames, decoded };
}

function readCrc(bytes) {
  // Independent CRC32 so the fixture does not trust the codec under test.
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function manifest({ gif, frames }) {
  return JSON.stringify({
    note: 'Generated by tests/fixtures/animation/make-gif.mjs. Ground truth: sample.gif decoded with GIF89a disposal/transparency rules, converted to 1-bit frames.',
    source: 'sample.gif',
    gifSha256: sha256(gif),
    width: WIDTH, height: HEIGHT,
    backgroundIndex: 0, backgroundRGB: [255, 255, 255],
    conversion: 'luminance = round(0.299R+0.587G+0.114B) with transparency composited over white; black when <128; stride 16; 1 = black; row padding bits are zero',
    blobLayout: 'kind:u8 reserved:u8=0 encLen:u16 crc:u32 payload[encLen] little-endian; see docs/protocol-animation.md',
    frames,
  }, null, 2) + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const built = buildFixtures();
  const files = {
    [OUTPUT.gif]: built.gif,
    [OUTPUT.unsupported]: built.truncated,
    [OUTPUT.frames]: Buffer.from(manifest(built)),
  };
  let failed = false;
  for (const [path, data] of Object.entries(files)) {
    if (check) {
      if (!existsSync(path)) { console.error(`missing ${path}`); failed = true; continue; }
      if (!readFileSync(path).equals(Buffer.from(data))) { console.error(`stale ${path}: regenerate with node tests/fixtures/animation/make-gif.mjs`); failed = true; }
    } else {
      writeFileSync(path, data);
      console.log(`wrote ${path} (${data.length} bytes)`);
    }
  }
  if (check && !failed) console.log('fixtures match the generator');
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
