// GIF import → 1-bit conversion → wire planning tests.
// Fixtures come from tests/fixtures/animation/make-gif.mjs (real GIF89a LZW,
// independent decoder as ground truth); no GIF bytes are committed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGif, GifError, GIF_MAX_FRAMES, GIF_FLOOR_DELAY_MS } from '../web/anim-gif.js';
import {
  effectiveDelay, throttleFrames, animationCrc, planOperations, estimateStats,
  formatBytes, formatDuration, decodeAnimStatus, packetBegin, packetFrame, packetData,
  packetRead, packetPlay, packetDelete, packetInfo, ANIM_OP, PER_OPERATION_MS,
  FALLBACK_SAFE_WRITE
} from '../web/anim.js';
import { WIDTH, HEIGHT, FRAME_BYTES, renderGray, packBits, crc32 } from '../web/image.js';
import { encodeFrame, FrameDecoder, parseBlobHeader, MAX_FRAMES, DELAY_MIN_MS, DELAY_MAX_MS } from '../web/anim-codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/animation');
const sample = () => fs.readFileSync(path.join(FIXTURES, 'sample.gif'));
const manifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'frames.json'), 'utf8'));

// Same calls render() makes, so this is the editor pipeline, not a copy of it.
const convert = (rgba, width, height, geometry = {}, pack = {}) =>
  packBits(renderGray(rgba, width, height, geometry), WIDTH, HEIGHT, pack);
const IDENTITY = { mode: 'fill', zoom: 1, x: 0, y: 0, rotation: 0, tileSize: 61 };
const PLAIN_PACK = { threshold: 128, dither: 'none', invert: false, brightness: 0, contrast: 0 };

// ------------------------------------------------------------------ decoder

test('decodes the fixture GIF: frame count, delays, disposal, transparency, rects', () => {
  const gif = decodeGif(sample());
  assert.equal(gif.version, '89a');
  assert.equal(gif.width, WIDTH);
  assert.equal(gif.height, HEIGHT);
  assert.equal(gif.loopCount, 0);
  assert.equal(gif.frames.length, 4);
  assert.deepEqual(gif.background, [255, 255, 255, 255]);
  const expected = manifest().frames;
  assert.deepEqual(gif.frames.map(f => f.delayMs), [120, 100, 250, 330]);
  assert.deepEqual(gif.frames.map(f => f.delayMs), expected.map(f => f.delayMs));
  assert.deepEqual(gif.frames.map(f => f.disposal), [1, 2, 1, 2]);
  assert.deepEqual(gif.frames.map(f => f.transparentIndex), [-1, 3, -1, 3]);
  assert.deepEqual(gif.frames.map(f => [f.left, f.top, f.width, f.height]), [[0, 0, 122, 250], [20, 30, 40, 40], [60, 120, 50, 60], [0, 200, 122, 50]]);
  // Every frame is a full logical-screen snapshot.
  for (const frame of gif.frames) assert.equal(frame.rgba.length, WIDTH * HEIGHT * 4);
});

test('composition matches the independent ground truth for every frame', () => {
  const gif = decodeGif(sample());
  const expected = manifest().frames;
  for (const [index, frame] of gif.frames.entries()) {
    const bits = convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK);
    assert.equal(Buffer.from(bits).toString('hex'), expected[index].frameHex, `frame ${index} pixels`);
    assert.equal(crc32(bits), expected[index].frameCrc, `frame ${index} crc`);
    assert.equal(frame.delayMs, expected[index].delayMs);
  }
});

test('disposal 2 restores the background and disposal 3 restores the previous frame', () => {
  const gif = decodeGif(sample());
  // Frame 0 paints the full canvas, so frame 1's rect starts from frame 0's
  // pixels; frame 1 uses disposal 2 and its rect must be gone in frame 2.
  const [f0, f1, f2] = gif.frames;
  const at = (frame, x, y) => [...frame.rgba.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4)];
  // (0,0) is frame 0's top-left quadrant colour and outside every later rect.
  assert.deepEqual(at(f0, 0, 0), at(f1, 0, 0));
  // (24,30) is a painted (non-transparent) pixel of frame 1's rect. Frame 1 is
  // disposed as 2, so frame 2 must show the white background there again.
  assert.notDeepEqual(at(f1, 24, 30), [255, 255, 255, 255]);
  assert.deepEqual(at(f2, 24, 30), [255, 255, 255, 255]);

  // Disposal 3 ("restore to previous") is not in the fixture, so build one from
  // raw bytes: 3x1 canvas, three frames, the middle one disposed as previous.
  const canvas = (() => {
    const bytes = [];
    const u16 = n => [n & 0xff, n >>> 8];
    // 4-colour global table: white, black, red, green.
    bytes.push(...[...'GIF89a'].map(c => c.charCodeAt(0)), ...u16(3), ...u16(1), 0x80 | 0x70 | 1, 0, 0);
    for (const rgb of [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0]]) bytes.push(...rgb);
    const sub = data => [data.length, ...data, 0];
    // Frame: GCE(delayCs, disposal, transparent) + descriptor + LZW literal data.
    const frame = (indices, delayCs, disposal) => {
      bytes.push(0x21, 0xf9, 4, (disposal & 7) << 2, ...u16(delayCs), 0, 0);
      bytes.push(0x2c, ...u16(0), ...u16(0), ...u16(3), ...u16(1), 0);
      // minCodeSize 2: codes are 3 bits, so emit clear, literals..., EOI.
      const clear = 4, eoi = 5;
      let acc = 0, bits = 0;
      const out = [];
      for (const code of [clear, ...indices, eoi]) {
        acc |= code << bits; bits += 3;
        while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; }
      }
      if (bits) out.push(acc & 0xff);
      bytes.push(2, ...sub(out));
    };
    frame([1, 1, 1], 10, 1); // all black, leave in place
    frame([2, 2, 2], 10, 3); // all red, restore to previous afterwards
    frame([3, 0, 3], 10, 1); // green/white/green
    bytes.push(0x3b);
    return Uint8Array.from(bytes);
  })();
  const g = decodeGif(canvas);
  const px = (frame, x) => [...frame.rgba.slice(x * 4, x * 4 + 4)];
  assert.deepEqual(px(g.frames[0], 0), [0, 0, 0, 255]);
  assert.deepEqual(px(g.frames[1], 0), [255, 0, 0, 255]);
  // Disposal 3 means frame 2 starts from frame 0 (black), so its middle pixel
  // shows white while the sides are green.
  assert.deepEqual(px(g.frames[2], 0), [0, 255, 0, 255]);
  assert.deepEqual(px(g.frames[2], 1), [255, 255, 255, 255]);
});

test('interlaced frames decode in the same order a progressive encoder would write', () => {
  // Frame 2 of the fixture is the only interlaced one. Re-encode the same pixel
  // data non-interlaced and require identical composited output.
  const interlaced = decodeGif(sample());
  const frame = interlaced.frames[2];
  // Ground truth from the fixture generator already covers interlace; assert the
  // pattern is not a single repeated row (a decoder that ignored interlace would
  // produce the same value on every row of the rect).
  const rows = new Set();
  for (let y = 0; y < frame.height; y++) {
    rows.add(Buffer.from(frame.rgba.subarray(((frame.top + y) * WIDTH + frame.left) * 4, ((frame.top + y) * WIDTH + frame.left + frame.width) * 4)).toString('base64'));
  }
  assert.ok(rows.size > 1, 'interlaced frame rows must differ');
  const expected = manifest().frames[2];
  assert.equal(Buffer.from(convert(frame.rgba, WIDTH, HEIGHT, IDENTITY, PLAIN_PACK)).toString('hex'), expected.frameHex);
});

test('rejects non-GIF, truncated, bad LZW and over-long animations with typed errors', () => {
  assert.throws(() => decodeGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0])), error => error instanceof GifError && error.code === 'not-gif');
  assert.throws(() => decodeGif(new Uint8Array(4)), error => error instanceof GifError && error.code === 'not-gif');
  assert.throws(() => decodeGif(fs.readFileSync(path.join(FIXTURES, 'unsupported.gif'))), error => error instanceof GifError && (error.code === 'truncated' || error.code === 'lzw'));

  // A clear code followed by a code outside the dictionary is a bad LZW stream.
  const bad = (() => {
    const bytes = [...sample().subarray(0, 13 + 12)];
    return Uint8Array.from(bytes);
  })();
  assert.throws(() => decodeGif(bad), error => error instanceof GifError);

  // Over-long animation: a 65-frame GIF built from the fixture's own first frame.
  const source = sample();
  const header = source.subarray(0, source.indexOf(0x2c));
  const trailer = source.subarray(source.lastIndexOf(0x3b));
  const firstFrameEnd = (() => {
    // Walk the first image block to its terminating zero-length sub-block.
    let pos = source.indexOf(0x2c) + 10;
    const packed = source[source.indexOf(0x2c) + 9];
    if (packed & 0x80) pos += (2 << (packed & 7)) * 3;
    pos += 1; // LZW minimum code size
    for (;;) { const size = source[pos++]; if (!size) break; pos += size; }
    return pos;
  })();
  const oneFrame = source.subarray(source.indexOf(0x2c), firstFrameEnd);
  const many = [header];
  for (let i = 0; i < 65; i++) many.push(oneFrame);
  many.push(trailer);
  const big = Uint8Array.from(Buffer.concat(many.map(part => Buffer.from(part))));
  assert.throws(() => decodeGif(big), error => error instanceof GifError && error.code === 'frame-limit' && error.max === GIF_MAX_FRAMES);
  assert.equal(decodeGif(big, { maxFrames: 65 }).frames.length, 65);
  assert.equal(MAX_FRAMES, 64);
});

// --------------------------------------------------- conversion identity

test('a PNG and a GIF frame with identical pixels produce identical 4000-byte frames', () => {
  const gif = decodeGif(sample());
  const expected = manifest().frames;
  for (const [index, frame] of gif.frames.entries()) {
    const fromGif = convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK);
    // The static editor path: the same RGBA through the same two calls, with
    // settings read from the live controls.
    const fromPng = packBits(renderGray(frame.rgba, gif.width, gif.height, { ...IDENTITY }), WIDTH, HEIGHT, { ...PLAIN_PACK });
    assert.equal(fromPng.length, FRAME_BYTES);
    assert.deepEqual(Buffer.from(fromPng), Buffer.from(fromGif), `frame ${index}`);
    assert.equal(Buffer.from(fromGif).toString('hex'), expected[index].frameHex);
    assert.equal(crc32(fromGif), expected[index].frameCrc);
  }
  // Settings other than the identity still agree across both sources, which is
  // the property that matters when the user has dithering on.
  const frame = gif.frames[1];
  const settings = { threshold: 200, dither: 'floyd-steinberg', invert: true, brightness: 10, contrast: -20 };
  const geometry = { mode: 'cover', zoom: 1.5, x: 3, y: -4, rotation: 90, tileSize: 61 };
  const a = convert(frame.rgba, gif.width, gif.height, geometry, settings);
  const b = packBits(renderGray(Uint8Array.from(frame.rgba), gif.width, gif.height, { ...geometry }), WIDTH, HEIGHT, { ...settings });
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

// --------------------------------------------------------------- delays

test('zero delay becomes the 100 ms browser convention and the raw value stays visible', () => {
  const gif = decodeGif(sample());
  // The fixture has no zero-delay frame, so state the rule directly.
  assert.equal(GIF_FLOOR_DELAY_MS, 100);
  const zero = { delayMs: 0, rawDelayMs: 0 };
  assert.equal(effectiveDelay(zero), 100);
  assert.equal(zero.rawDelayMs, 0);
  assert.equal(effectiveDelay({ delayMs: 40, rawDelayMs: 40 }), 100);
  assert.equal(effectiveDelay({ delayMs: 250, rawDelayMs: 250 }), 250);
  assert.equal(effectiveDelay({ delayMs: 250 }, 500), 500);
  assert.equal(effectiveDelay({ delayMs: 90000 }), DELAY_MAX_MS);
  assert.equal(effectiveDelay({ delayMs: 5 }, 1), DELAY_MIN_MS);
  assert.equal(effectiveDelay(gif.frames[3]), 330);
});

test('throttling keeps every Nth frame and reports what it dropped', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ delayMs: 100 + i, rawDelayMs: 100 + i }));
  assert.deepEqual(throttleFrames(frames, 1).frames.map(f => f.delayMs), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  assert.deepEqual(throttleFrames(frames, 2).frames.map(f => f.delayMs), [100, 102, 104, 106, 108]);
  assert.deepEqual(throttleFrames(frames, 3).frames.map(f => f.delayMs), [100, 103, 106, 109]);
  assert.deepEqual(throttleFrames(frames, 4).frames.map(f => f.delayMs), [100, 104, 108]);
  const eight = throttleFrames(frames, 8);
  assert.deepEqual(eight.frames.map(f => f.delayMs), [100, 108]);
  assert.equal(eight.step, 8);
  assert.equal(eight.dropped, 8);
  // Out-of-range requests clamp instead of failing.
  assert.equal(throttleFrames(frames, 0).step, 1);
  assert.equal(throttleFrames(frames, 99).step, 8);
  assert.equal(throttleFrames(frames, 99).frames.length, 2);
  // 64 kept frames out of a 200-frame animation still fit the wire limit.
  const many = Array.from({ length: 200 }, () => ({ delayMs: 100 }));
  assert.equal(throttleFrames(many, 4).frames.length, 50);
});

// ------------------------------------------------------------ wire math

test('encoded sizes, compression ratio and the BLE estimate use the stated assumption', () => {
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const encoded = [];
  let previous = null;
  for (const frame of frames) { encoded.push(encodeFrame(previous, frame)); previous = frame; }
  const lengths = encoded.map(e => e.blob.length);

  // Blob length is the 8-byte header plus the payload; encLen is payload only.
  // The header CRC covers the 4000 decoded bytes, not the packed payload.
  for (const [i, e] of encoded.entries()) {
    assert.equal(e.blob.length, 8 + e.encLen);
    const header = parseBlobHeader(e.blob);
    assert.equal(header.encLen, e.encLen);
    assert.equal(header.crc, e.crc);
    assert.equal(header.crc, crc32(frames[i]));
  }
  const manifestFrames = manifest().frames;
  assert.deepEqual(encoded.map(e => e.kind), manifestFrames.map(f => f.kind));
  assert.deepEqual(encoded.map(e => e.encLen), manifestFrames.map(f => f.encLen));
  assert.deepEqual(encoded.map(e => Buffer.from(e.blob).toString('hex')), manifestFrames.map(f => f.blobHex));

  const stats = estimateStats(lengths, { safeWrite: 244 });
  const encodedBytes = lengths.reduce((a, b) => a + b, 0);
  assert.equal(stats.count, 4);
  assert.equal(stats.encodedBytes, encodedBytes);
  assert.equal(stats.rawBytes, 4 * FRAME_BYTES);
  assert.equal(stats.ratio, 16000 / encodedBytes);
  assert.equal(stats.payloadMax, 241);
  assert.equal(stats.safeWrite, 244);
  assert.equal(stats.perOperationMs, PER_OPERATION_MS);
  // BEGIN + 4x(FRAME + FRAME_COMMIT + DATA) + COMMIT + PLAY
  const expectedOps = 3 + 4 * 2 + lengths.reduce((sum, len) => sum + Math.ceil(len / 241), 0);
  assert.equal(stats.ops, expectedOps);
  assert.equal(stats.timeMs, expectedOps * PER_OPERATION_MS);

  // Fallback ceiling: MTU 23 => 20-byte writes => 17 payload bytes per DATA.
  const fallback = estimateStats(lengths);
  assert.equal(fallback.safeWrite, FALLBACK_SAFE_WRITE);
  assert.equal(fallback.payloadMax, 17);
  assert.equal(fallback.ops, 3 + 4 * 2 + lengths.reduce((sum, len) => sum + Math.ceil(len / 17), 0));
  assert.ok(fallback.ops > stats.ops);
  assert.equal(fallback.timeMs, fallback.ops * PER_OPERATION_MS);

  // Verification adds one READ round trip per chunk at 18 payload bytes.
  const verified = estimateStats(lengths, { safeWrite: 244, verify: true });
  assert.equal(verified.ops, stats.ops + lengths.reduce((sum, len) => sum + Math.ceil(len / 18), 0));
  // Sending without PLAY saves one round trip.
  assert.equal(estimateStats(lengths, { safeWrite: 244, play: false }).ops, stats.ops - 1);
  assert.equal(planOperations([], { safeWrite: 244 }).ops, 3);

  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatDuration(450), '450 ms');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(65000), '1 min 5 s');
});

test('the animation CRC folds every decoded frame in index order', () => {
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const all = new Uint8Array(frames.length * FRAME_BYTES);
  frames.forEach((frame, i) => all.set(frame, i * FRAME_BYTES));
  assert.equal(animationCrc(frames), crc32(all));
  assert.notEqual(animationCrc(frames), crc32(frames[0]));
  // Order matters: swapping two frames changes the CRC.
  const swapped = [frames[1], frames[0], ...frames.slice(2)];
  assert.notEqual(animationCrc(swapped), animationCrc(frames));
});

// ------------------------------------------------------------ wire packets

test('command packets match the frozen layout', () => {
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...packetInfo()], [0x01]);

  const begin = packetBegin(0x11223344, 4, 0, 0xdeadbeef);
  assert.equal(begin.length, 13);
  assert.deepEqual([...begin.subarray(0, 1)], [0x02]);
  assert.equal(view(begin).getUint32(1, true), 0x11223344);
  assert.equal(view(begin).getUint16(5, true), 4);
  assert.equal(view(begin).getUint16(7, true), 0);
  assert.equal(view(begin).getUint32(9, true), 0xdeadbeef);

  const frame = packetFrame(3, 1, 1000, 0x01020304, 250);
  assert.equal(frame.length, 13);
  assert.equal(frame[0], 0x03);
  assert.equal(view(frame).getUint16(1, true), 3);
  assert.equal(frame[3], 1);
  assert.equal(frame[4], 0);
  assert.equal(view(frame).getUint16(5, true), 1000);
  assert.equal(view(frame).getUint32(7, true), 0x01020304);
  assert.equal(view(frame).getUint16(11, true), 250);

  const data = packetData(17, Uint8Array.of(9, 8, 7));
  assert.equal(data[0], 0x04);
  assert.equal(view(data).getUint16(1, true), 17);
  assert.deepEqual([...data.subarray(3)], [9, 8, 7]);
  assert.equal(data.length, 6);

  assert.deepEqual([...packetRead(5, 400)], [0x0a, 5, 0, 0x90, 0x01]);
  assert.deepEqual([...packetPlay(2)], [0x07, 2, 0]);
  assert.deepEqual([...packetDelete(0x01020304)], [0x09, 4, 3, 2, 1]);
  assert.equal(ANIM_OP.FRAME_COMMIT, 0x05);
  assert.equal(ANIM_OP.ABORT, 0x0c);
});

test('status decoding reads the 20-byte layout and rejects other versions', () => {
  const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
  bytes[0] = 1; bytes[1] = 0x03; bytes[2] = 0; bytes[3] = 0x03;
  view.setUint32(4, 7, true);
  view.setUint16(8, 4, true);
  view.setUint16(10, 2, true);
  view.setUint32(12, 1234, true);
  view.setUint32(16, 0xabcdef01, true);
  const status = decodeAnimStatus(bytes);
  assert.deepEqual(status, {
    version: 1, op: 3, error: 0, flags: 3, pending: true, playing: true,
    revision: 7, count: 4, index: 2, dataBytes: 1234, animCrc: 0xabcdef01
  });
  const wrongVersion = bytes.slice(); wrongVersion[0] = 2;
  assert.throws(() => decodeAnimStatus(wrongVersion), /Invalid animation status/);
  const short = bytes.slice(0, 19);
  assert.throws(() => decodeAnimStatus(short), /Invalid animation status/);
  const badFlags = bytes.slice(); badFlags[3] = 0x04;
  assert.throws(() => decodeAnimStatus(badFlags), /Invalid animation status/);
});

test('a full send/read-back round trip decodes to the local frames', () => {
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const blobs = [];
  let previous = null;
  for (const frame of frames) { blobs.push(encodeFrame(previous, frame).blob); previous = frame; }
  const decoder = new FrameDecoder();
  for (const [i, blob] of blobs.entries()) {
    const decoded = decoder.push(blob);
    assert.equal(decoded.bytes.length, FRAME_BYTES);
    assert.equal(crc32(decoded.bytes), crc32(frames[i]));
    assert.deepEqual(Buffer.from(decoded.bytes), Buffer.from(frames[i]));
  }
  // Every blob is chunked into the payload ceiling the wire uses.
  const safeWrite = 244, payloadMax = safeWrite - 3;
  for (const blob of blobs) {
    let chunks = 0;
    for (let offset = 0; offset < blob.length; offset += payloadMax) {
      const end = Math.min(offset + payloadMax, blob.length);
      assert.ok(end - offset <= payloadMax);
      assert.ok(packetData(offset, blob.subarray(offset, end)).length <= safeWrite);
      chunks++;
    }
    assert.equal(chunks, Math.ceil(blob.length / payloadMax));
  }
});

// ------------------------------------------------- send flow over fake BLE
// A fake device that implements the frozen status machine: one 20-byte status
// characteristic, the data characteristic, and a durable animation slot. It
// counts operations so the test can assert ABORT and read-back behaviour.
function fakeDevice() {
  const state = {
    revision: 3, count: 0, index: 0xffff, pending: false, playing: false,
    op: 0, error: 0, dataBytes: 0, animCrc: 0,
    staging: null, stored: null, writes: [], reads: 0, aborts: 0, committed: 0,
    lastRead: null, requests: [], resumeIndex: 2, restoredStatic: false, ackUnresolvedResume: false
  };
  const statusBytes = () => {
    const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
    bytes[0] = 1; bytes[1] = state.op; bytes[2] = state.error;
    bytes[3] = (state.pending ? 1 : 0) | (state.playing ? 2 : 0);
    view.setUint32(4, state.revision, true);
    view.setUint16(8, state.count, true);
    view.setUint16(10, state.index, true);
    view.setUint32(12, state.dataBytes, true);
    view.setUint32(16, state.animCrc, true);
    return new DataView(bytes.buffer);
  };
  const blobAt = i => state.staging ? state.staging[i] : null;
  const command = {
    properties: { write: true },
    async writeValueWithResponse(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      state.writes.push(bytes[0]);
      state.op = bytes[0]; state.error = 0;
      switch (bytes[0]) {
        case 0x01: // INFO
          state.dataBytes = state.stored ? state.stored.blobs.reduce((a, b) => a + b.length, 0) : 0;
          state.count = state.stored ? state.stored.blobs.length : 0;
          state.animCrc = state.stored ? state.stored.crc : 0;
          state.index = state.stored ? state.stored.index : 0xffff;
          state.playing = state.stored ? state.stored.playing : false;
          return;
        case 0x02: { // BEGIN
          if (view.getUint32(1, true) !== state.revision) { state.error = 4; return; }
          const count = view.getUint16(5, true);
          if (count < 1 || count > 64 || view.getUint16(7, true) & ~1) { state.error = 1; return; }
          state.staging = { count, crc: view.getUint32(9, true), blobs: new Array(count).fill(null), delays: [] };
          state.index = 0; // BEGIN reports the next index that must be committed
          return;
        }
        case 0x03: { // FRAME
          if (!state.staging) { state.error = 1; return; }
          const index = view.getUint16(1, true);
          if (index >= state.staging.count) { state.error = 11; return; }
          const encLen = view.getUint16(5, true);
          // DATA offsets are payload-only; the firmware synthesizes the 8-byte
          // blob header at FRAME_COMMIT.
          state.staging.blobs[index] = { kind: bytes[3], encLen, crc: view.getUint32(7, true), delayMs: view.getUint16(11, true), payload: new Uint8Array(encLen), have: 0 };
          state.staging.current = index;
          state.staging.delays[index] = view.getUint16(11, true);
          state.index = index;
          return;
        }
        case 0x04: { // DATA
          const offset = view.getUint16(1, true);
          const blob = state.staging?.blobs[state.staging.current];
          if (!blob || blob.have !== offset) { state.error = 8; return; }
          const payload = new Uint8Array(bytes.buffer, bytes.byteOffset + 3, bytes.byteLength - 3);
          if (offset + payload.length > blob.encLen) { state.error = 11; return; }
          blob.payload.set(payload, offset); blob.have += payload.length;
          state.index = blob.have; // exact next expected payload offset
          return;
        }
        case 0x05: { // FRAME_COMMIT
          const blob = state.staging?.blobs[state.staging?.current];
          if (!blob || blob.have !== blob.encLen) { state.error = 1; return; }
          // The next index to commit, or 0xFFFF when all frames are committed.
          state.index = state.staging.current + 1 < state.staging.count ? state.staging.current + 1 : 0xffff;
          return;
        }
        case 0x06: { // COMMIT
          if (!state.staging || state.staging.blobs.some(b => !b)) { state.error = 1; return; }
          // Stored blobs = synthesized header + received payload.
          const blobs = state.staging.blobs.map(b => {
            const blob = new Uint8Array(8 + b.encLen);
            blob[0] = b.kind; blob[1] = 0;
            blob[2] = b.encLen & 0xff; blob[3] = b.encLen >>> 8;
            blob[4] = b.crc & 0xff; blob[5] = (b.crc >>> 8) & 0xff; blob[6] = (b.crc >>> 16) & 0xff; blob[7] = (b.crc >>> 24) & 0xff;
            blob.set(b.payload, 8);
            return blob;
          });
          state.stored = { blobs, delays: state.staging.delays, crc: state.staging.crc, index: 0, playing: false };
          state.staging = null; state.revision++; state.committed++;
          state.count = blobs.length; state.animCrc = state.stored.crc; state.dataBytes = blobs.reduce((a, b) => a + b.length, 0); state.index = 0;
          return;
        }
        case 0x07: { // PLAY
          if (!state.stored) { state.error = 3; return; }
          const requested = view.getUint16(1, true);
          // 0xFFFF resumes the last persisted position (frame 2 in this fake).
          // A buggy device may answer 0xFFFF as the resolved index; model that
          // separately so the client-side guard is what gets exercised.
          const start = requested === 0xffff ? state.resumeIndex : requested;
          if (requested === 0xffff && state.ackUnresolvedResume) {
            state.index = 0xffff; state.playing = true;
            return;
          }
          if (start >= state.stored.blobs.length) { state.error = 11; return; }
          state.index = start; state.playing = true;
          state.stored.playing = true; state.stored.index = start;
          state.requests.push(requested);
          return;
        }
        case 0x08: // STOP
          if (!state.stored) { state.error = 3; return; }
          // STOP stops playback and restores static content on the panel; the
          // animation is not left frozen on screen.
          state.playing = false; state.stored.playing = false;
          state.index = 0xffff; state.stored.index = 0xffff;
          state.restoredStatic = true;
          return;
        case 0x09: // DELETE
          if (!state.stored) { state.error = 3; return; }
          if (view.getUint32(1, true) !== state.revision) { state.error = 4; return; }
          state.stored = null; state.revision++; state.count = 0; state.index = 0xffff; state.animCrc = 0; state.dataBytes = 0;
          return;
        case 0x0a: { // READ
          const index = view.getUint16(1, true), offset = view.getUint16(3, true);
          const blob = state.stored?.blobs[index];
          if (!blob) { state.error = 3; return; }
          if (offset > blob.length) { state.error = 8; return; }
          state.reads++;
          state.dataBytes = blob.length;
          state.lastRead = { index, offset, blob };
          return;
        }
        case 0x0c: // ABORT
          state.aborts++; state.staging = null;
          return;
        default:
          state.error = 1;
      }
    }
  };
  const status = {
    properties: { read: true },
    async readValue() { return statusBytes(); }
  };
  const data = {
    properties: { read: true },
    async readValue() {
      if (!state.lastRead) throw new Error('no READ outstanding');
      const { offset, blob } = state.lastRead;
      const chunk = blob.subarray(offset, offset + 18);
      const out = new Uint8Array(2 + chunk.length), view = new DataView(out.buffer);
      view.setUint16(0, offset, true);
      out.set(chunk, 2);
      return new DataView(out.buffer);
    }
  };
  // Two services: 7b1e0010 holds the animation characteristics, 7b1e0001 the
  // editor's capability characteristic (absent here on purpose).
  const notFound = uuid => { const error = new Error(`no characteristic ${uuid}`); error.name = 'NotFoundError'; return error; };
  const transport = {
    device: { gatt: {
      connected: true,
      async getPrimaryService(uuid) {
        if (uuid === '7b1e0010-6ba2-4f25-8ac7-1d54e91a1000') {
          return { async getCharacteristic(characteristic) {
            if (characteristic === '7b1e0011-6ba2-4f25-8ac7-1d54e91a1000') return command;
            if (characteristic === '7b1e0012-6ba2-4f25-8ac7-1d54e91a1000') return status;
            if (characteristic === '7b1e0013-6ba2-4f25-8ac7-1d54e91a1000') return data;
            throw notFound(characteristic);
          } };
        }
        // The editor service exists but exposes no capabilities characteristic.
        if (uuid === '7b1e0001-6ba2-4f25-8ac7-1d54e91a1000') {
          return { async getCharacteristic(characteristic) { throw notFound(characteristic); } };
        }
        throw notFound(uuid);
      }
    } },
    run: async (_name, fn) => fn({}),
    operation: async (_context, _stage, action) => action()
  };
  return { state, transport };
}

test('send writes BEGIN/FRAME/DATA/FRAME_COMMIT/COMMIT/PLAY and read-back verifies', async () => {
  const { withAnim } = await import('../web/anim.js');
  const { state, transport } = fakeDevice();
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const blobs = [], crcs = [], delays = [], encLens = [];
  let previous = null;
  for (const [i, frame] of frames.entries()) {
    const encoded = encodeFrame(previous, frame);
    blobs.push(encoded.blob); crcs.push(encoded.crc); delays.push(gif.frames[i].delayMs); encLens.push(encoded.encLen);
    previous = frame;
  }
  const progress = [];
  const result = await withAnim(transport, wire => wire.send(frames, { blobs, crcs, delays, encLens }, {
    start: 0, verify: true, loop: true,
    progress: (sent, total) => progress.push([sent, total]),
    onPhase: phase => progress.push(['phase', phase])
  }));
  assert.equal(result.count, 4);
  assert.equal(result.revision, 4);
  // Progress counts payload bytes only (DATA never sends the blob headers).
  assert.equal(result.bytes, blobs.reduce((a, b) => a + b.length - 8, 0));
  assert.equal(result.storedBytes, blobs.reduce((a, b) => a + b.length, 0));
  // BEGIN carried the loop flag.
  assert.ok(state.writes.includes(0x02));
  assert.equal(state.committed, 1);
  assert.equal(state.aborts, 0);
  assert.equal(state.stored.blobs.length, 4);
  assert.equal(state.playing, true);
  // Every frame was read back once per chunk, and the read-back decoded to the
  // local frames (a mismatch would have thrown).
  assert.ok(state.reads >= 4, `expected at least one READ per frame, got ${state.reads}`);
  assert.ok(progress.some(entry => entry[0] === 'phase' && entry[1] === 'verify'));
  // Byte progress is monotonic and ends at the total.
  const bytes = progress.filter(entry => typeof entry[0] === 'number');
  assert.ok(bytes.length > 4);
  for (let i = 1; i < bytes.length; i++) assert.ok(bytes[i][0] >= bytes[i - 1][0]);
  assert.equal(bytes.at(-1)[0], bytes.at(-1)[1]);
  assert.equal(bytes.at(-1)[1], result.bytes);
  // STOP and DELETE round-trip against the fake device.
  const stopped = await withAnim(transport, wire => wire.stop());
  assert.equal(stopped.playing, false);
  const info = await withAnim(transport, wire => wire.info());
  assert.equal(info.count, 4);
  assert.equal(info.animCrc, result.crc);
  const removed = await withAnim(transport, wire => wire.remove(info.revision));
  assert.equal(removed.revision, info.revision + 1);
  const after = await withAnim(transport, wire => wire.info());
  assert.equal(after.count, 0);
  assert.equal(after.index, 0xffff);
});

test('a cancelled transfer sends ABORT and leaves the previous animation intact', async () => {
  const { withAnim } = await import('../web/anim.js');
  const { state, transport } = fakeDevice();
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const encodeAll = list => {
    const blobs = [], crcs = [], delays = [], encLens = [];
    let previous = null;
    for (const frame of list) {
      const encoded = encodeFrame(previous, frame);
      blobs.push(encoded.blob); crcs.push(encoded.crc); delays.push(200); encLens.push(encoded.encLen);
      previous = frame;
    }
    return { blobs, crcs, delays, encLens };
  };
  // First store a two-frame animation.
  await withAnim(transport, wire => wire.send(frames.slice(0, 2), encodeAll(frames.slice(0, 2)), { start: null }));
  const before = await withAnim(transport, wire => wire.info());
  assert.equal(before.count, 2);

  // Then start a four-frame upload and cancel after the first DATA chunk.
  let cancelled = false;
  await assert.rejects(
    withAnim(transport, wire => wire.send(frames, encodeAll(frames), {
      start: null,
      cancelled: () => cancelled,
      progress: () => { cancelled = true; }
    })),
    /cancelled/i
  );
  assert.ok(state.aborts >= 1, 'ABORT must be sent for a cancelled staged transfer');
  const after = await withAnim(transport, wire => wire.info());
  assert.equal(after.count, 2, 'the previous animation must survive a cancel');
  assert.equal(after.animCrc, before.animCrc);
  assert.equal(after.revision, before.revision);
});

test('a revision conflict aborts and reports the device error, not a false success', async () => {
  const { withAnim } = await import('../web/anim.js');
  const { state, transport } = fakeDevice();
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const blobs = [], crcs = [], delays = [], encLens = [];
  let previous = null;
  for (const frame of frames) { const e = encodeFrame(previous, frame); blobs.push(e.blob); crcs.push(e.crc); delays.push(150); encLens.push(e.encLen); previous = frame; }
  // Make the device's durable revision differ from what INFO reported by
  // bumping it between the INFO read and BEGIN.
  const wrapped = {
    ...transport,
    device: { gatt: { connected: true, getPrimaryService: async uuid => {
      const service = await transport.device.gatt.getPrimaryService(uuid);
      if (uuid !== '7b1e0010-6ba2-4f25-8ac7-1d54e91a1000') return service;
      return {
        async getCharacteristic(characteristic) {
          const real = await service.getCharacteristic(characteristic);
          if (characteristic !== '7b1e0011-6ba2-4f25-8ac7-1d54e91a1000') return real;
          return {
            properties: real.properties,
            async writeValueWithResponse(bytes) {
              if (bytes[0] === 0x02) state.revision += 1; // simulate a racing writer
              return real.writeValueWithResponse(bytes);
            }
          };
        }
      };
    } } }
  };
  await assert.rejects(withAnim(wrapped, wire => wire.send(frames, { blobs, crcs, delays, encLens }, { start: null })), error => error.deviceError === true && error.code === 4);
  assert.equal(state.stored, null, 'nothing may be committed after a conflict');
  assert.equal(state.committed, 0);
});

// ------------------------------------------------------- DOM integration
// jsdom + @napi-rs/canvas, mirroring tests/ui.test.js: the GIF must arrive
// through the existing #file input, populate the animation panel, and leave the
// static image, text panel and menu behaviour untouched.
test('the existing file input routes a GIF to the animation panel without touching the static image', async () => {
  const { JSDOM } = await import('jsdom');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'), { url: 'http://localhost/' });
  const { window } = dom, doc = window.document;
  const previousGlobals = {};
  const setGlobal = (key, value) => {
    previousGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  setGlobal('navigator', window.navigator);
  setGlobal('document', doc);
  setGlobal('Event', window.Event);
  setGlobal('Node', window.Node);
  setGlobal('ImageData', window.ImageData);
  // jsdom has no object URLs; hand the PNG path a data URL it can decode.
  const objects = new Map();
  let objectCount = 0;
  setGlobal('URL', { ...globalThis.URL, createObjectURL: blob => { const key = `blob:local-${++objectCount}`; objects.set(key, blob); return key; }, revokeObjectURL: key => objects.delete(key) });
  setGlobal('Image', class {
    async decode() {
      const source = this.src.startsWith('blob:')
        ? Buffer.from(await objects.get(this.src).arrayBuffer())
        : this.src;
      this.native = await loadImage(source);
      this.naturalWidth = this.native.width;
      this.naturalHeight = this.native.height;
    }
  });
  const canvases = new WeakMap();
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!canvases.has(this)) canvases.set(this, createCanvas(this.width, this.height));
    const ctx = canvases.get(this).getContext('2d');
    return new Proxy(ctx, {
      get(target, key) { if (key === 'drawImage') return (image, ...args) => target.drawImage(image.native ?? canvases.get(image) ?? image, ...args); const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; },
      set(target, key, value) { return Reflect.set(target, key, value, target); }
    });
  };
  window.HTMLCanvasElement.prototype.toBlob = function toBlob(callback) { callback(new Blob([canvases.get(this).toBuffer('image/png')], { type: 'image/png' })); };
  try {
    await import('../web/app.js');
    const $ = id => doc.getElementById(id);
    assert.equal($('anim-name').textContent.trim(), 'No animation selected');
    assert.equal($('anim-frame-count').textContent.trim(), '—');
    assert.equal($('anim-play').disabled, true);
    assert.equal($('text-panel').hidden, true);
    // A GIF through the ordinary input must not become the static image.
    const file = new Blob([sample()], { type: 'image/gif' });
    Object.defineProperty(file, 'name', { value: 'sample.gif' });
    Object.defineProperty($('file'), 'files', { value: [file], configurable: true });
    $('file').dispatchEvent(new window.Event('change'));
    for (let n = 0; n < 200 && $('anim-name').textContent !== 'sample.gif'; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal($('anim-name').textContent, 'sample.gif');
    assert.equal($('image-name').textContent.trim(), 'No image selected', 'a GIF must not replace the static image');
    assert.equal($('anim-frame-count').textContent.trim(), '4');
    assert.match($('anim-encoded-bytes').textContent, /KB/);
    assert.match($('anim-ratio').textContent, /×/);
    assert.match($('anim-ble-time').textContent, /ms|s/);
    assert.match($('anim-assumption').textContent, /MTU 23/);
    assert.equal($('anim-play').disabled, false);
    assert.equal($('anim-send').disabled, true, 'send needs a connection');
    assert.equal($('anim-counter').textContent.trim(), 'Frame 1 / 4');
    // The preview canvas holds real converted pixels.
    const pixels = canvases.get($('anim-preview')).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
    let black = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 0) black++;
    assert.ok(black > 1000 && black < WIDTH * HEIGHT, `preview must be a real 1-bit image (black=${black})`);
    // Throttling recomputes the visible count.
    $('anim-keep').value = '3';
    $('anim-keep').dispatchEvent(new window.Event('change'));
    assert.equal($('anim-frame-count').textContent.trim(), '2');
    $('anim-keep').value = '1';
    $('anim-keep').dispatchEvent(new window.Event('change'));
    assert.equal($('anim-frame-count').textContent.trim(), '4');
    // A minimum delay above the file's own delays raises every frame's delay.
    $('anim-min-delay').value = '500';
    $('anim-min-delay').dispatchEvent(new window.Event('change'));
    assert.equal($('anim-frame-count').textContent.trim(), '4');
    $('anim-min-delay').value = '100';
    $('anim-min-delay').dispatchEvent(new window.Event('change'));
    // The static PNG path still works after a GIF import.
    const png = new Blob([fs.readFileSync(path.join(ROOT, 'tests/fixtures/approved-native.png'))], { type: 'image/png' });
    Object.defineProperty(png, 'name', { value: 'local.png' });
    Object.defineProperty($('file'), 'files', { value: [png], configurable: true });
    $('file').dispatchEvent(new window.Event('change'));
    for (let n = 0; n < 200 && $('image-name').textContent !== 'local.png'; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal($('image-name').textContent, 'local.png');
    assert.equal($('anim-name').textContent, 'sample.gif', 'a PNG must not clear the loaded animation');
    // Menu behaviour is unchanged.
    const menu = doc.querySelector('[data-action="invert"]');
    menu.closest('details').open = true;
    menu.click();
    assert.equal($('invert').checked, true);
    assert.equal(menu.closest('details').open, false);
    // A rejected GIF reports a localized error and keeps the loaded animation.
    const broken = new Blob([fs.readFileSync(path.join(FIXTURES, 'unsupported.gif'))], { type: 'image/gif' });
    Object.defineProperty(broken, 'name', { value: 'broken.gif' });
    Object.defineProperty($('file'), 'files', { value: [broken], configurable: true });
    $('file').dispatchEvent(new window.Event('change'));
    for (let n = 0; n < 200 && !$('anim-status').dataset.error?.includes('true'); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal($('anim-status').dataset.error, 'true');
    assert.match($('anim-status').textContent, /Could not open the animation/);
    assert.equal($('anim-name').textContent, 'sample.gif', 'a rejected import must not clear the previous animation');
    assert.equal($('anim-frame-count').textContent.trim(), '4');
  } finally {
    for (const [key, descriptor] of Object.entries(previousGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test('old firmware without the animation service reports "unavailable", not a transport error', async () => {
  const { withAnim, AnimUnavailableError } = await import('../web/anim.js');
  const notFound = uuid => { const error = new Error(`no service ${uuid}`); error.name = 'NotFoundError'; return error; };
  const transport = {
    device: { gatt: { connected: true, async getPrimaryService(uuid) {
      // The editor service exists, the animation service does not.
      if (uuid === '7b1e0001-6ba2-4f25-8ac7-1d54e91a1000') return { async getCharacteristic(c) { throw notFound(c); } };
      throw notFound(uuid);
    } } },
    run: async (_name, fn) => fn({}),
    operation: async (_context, _stage, action) => action()
  };
  await assert.rejects(withAnim(transport, () => 'unreachable'), error => {
    assert.ok(error instanceof AnimUnavailableError);
    assert.equal(error.unavailable, true);
    assert.match(error.message, /no animation service/);
    return true;
  });
  // A device that is merely disconnected is a different, ordinary failure.
  const offline = { ...transport, device: { gatt: { connected: false } } };
  await assert.rejects(withAnim(offline, () => 'unreachable'), /Connect to the display first/);
  // The dedicated service and characteristics are the frozen animation UUIDs.
  const { ANIM_UUIDS } = await import('../web/anim.js');
  assert.deepEqual(ANIM_UUIDS, {
    service: '7b1e0010-6ba2-4f25-8ac7-1d54e91a1000',
    command: '7b1e0011-6ba2-4f25-8ac7-1d54e91a1000',
    status: '7b1e0012-6ba2-4f25-8ac7-1d54e91a1000',
    data: '7b1e0013-6ba2-4f25-8ac7-1d54e91a1000'
  });
});

// ------------------------------------------------------ resume and restore

test('Resume sends PLAY 0xFFFF and surfaces the index the device actually used', async () => {
  const { withAnim, PLAY_RESUME, packetPlay } = await import('../web/anim.js');
  const { t } = await import('../web/i18n.js');
  const { state, transport } = fakeDevice();
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const encodeAll = list => {
    const blobs = [], crcs = [], delays = [], encLens = [];
    let previous = null;
    for (const frame of list) {
      const encoded = encodeFrame(previous, frame);
      blobs.push(encoded.blob); crcs.push(encoded.crc); delays.push(200); encLens.push(encoded.encLen);
      previous = frame;
    }
    return { blobs, crcs, delays, encLens };
  };
  // 0xFFFF is written as a plain u16 by the existing builder.
  assert.equal(PLAY_RESUME, 0xffff);
  const requestBytes = packetPlay(PLAY_RESUME);
  assert.deepEqual([...requestBytes], [0x07, 0xff, 0xff]);
  assert.deepEqual([...packetPlay(0)], [0x07, 0x00, 0x00]);

  await withAnim(transport, wire => wire.send(frames, encodeAll(frames), { start: null }));
  // The device resumes at frame index 2 (0-based) whatever was persisted.
  state.resumeIndex = 2;
  state.writes.length = 0;
  state.requests.length = 0;
  const resumed = await withAnim(transport, wire => wire.play(PLAY_RESUME));
  assert.deepEqual(state.requests, [0xffff], 'the wire must carry PLAY start 0xFFFF');
  assert.ok(state.writes.includes(0x07));
  assert.equal(resumed.start, 2, 'the ack index is the resolved start');
  assert.equal(resumed.resumed, true);
  assert.equal(state.index, 2);
  assert.equal(state.playing, true);
  // The UI text is 1-based: "resumed from frame {index}" with index 3.
  const text = t('anim.resumedAt', { index: resumed.start + 1 });
  assert.match(text, /from frame 3/);
  assert.equal(t('anim.resumedAt', { index: 1 }), 'Resumed playback on the display from frame 1.');

  // A literal start is still validated: PLAY 1 must be acknowledged as 1.
  const literal = await withAnim(transport, wire => wire.play(1));
  assert.equal(literal.start, 1);
  assert.equal(literal.resumed, false);
  // A device that answers 0xFFFF for a resume did not resume anything real.
  state.ackUnresolvedResume = true;
  await assert.rejects(withAnim(transport, wire => wire.play(PLAY_RESUME)), /Unexpected PLAY acknowledgement/);
  state.ackUnresolvedResume = false;
  // An out-of-range resume target is a device range error, still a failure
  // rather than a silent success.
  state.resumeIndex = 99;
  await assert.rejects(withAnim(transport, wire => wire.play(PLAY_RESUME)), error => error.deviceError === true && error.code === 11);
});

test('STOP stops playback and restores static content, never a frozen frame', async () => {
  const { withAnim } = await import('../web/anim.js');
  const { t } = await import('../web/i18n.js');
  const { state, transport } = fakeDevice();
  const gif = decodeGif(sample());
  const frames = gif.frames.map(frame => convert(frame.rgba, gif.width, gif.height, IDENTITY, PLAIN_PACK));
  const blobs = [], crcs = [], delays = [], encLens = [];
  let previous = null;
  for (const frame of frames) { const e = encodeFrame(previous, frame); blobs.push(e.blob); crcs.push(e.crc); delays.push(180); encLens.push(e.encLen); previous = frame; }
  await withAnim(transport, wire => wire.send(frames, { blobs, crcs, delays, encLens }, { start: 0 }));
  assert.equal((await withAnim(transport, wire => wire.info())).playing, true);

  const stopped = await withAnim(transport, wire => wire.stop());
  assert.equal(stopped.playing, false);
  assert.equal(stopped.index, 0xffff, 'a stopped device reports no playing index');
  assert.equal(state.playing, false);
  assert.equal(state.restoredStatic, true, 'STOP must restore static content on the device');

  // The status line must describe the restore, not a frozen frame.
  const text = t('anim.deviceStoppedRestored');
  assert.match(text, /first stored page/);
  assert.match(text, /cleared if no pages are stored/);
  assert.doesNotMatch(text, /frame|frozen|last/i);
  // And with playing false + index 0xFFFF the state line cannot claim a paused
  // frame: pollInfo renders anim.stateReady, which carries no frame index.
  assert.doesNotMatch(t('anim.stateReady'), /\{index\}/);
  assert.match(t('anim.stateReady'), /\{count\}/);
  // Russian wording exists and makes the same claim.
  const { default: ru } = await import('../web/locales/ru.js');
  assert.match(ru['anim.deviceStoppedRestored'], /первой сохранённой странице/);
  assert.doesNotMatch(ru['anim.deviceStoppedRestored'], /\{index\}/);
  assert.equal(t('anim.deviceResume').length > 0, true);
  assert.match(ru['anim.resumedAt'], /\{index\}/);
});
