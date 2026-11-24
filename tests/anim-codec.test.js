import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  FRAME_BYTES, MAX_FRAMES, FRAME_HEADER_BYTES, MAX_BLOB_BYTES, DATA_BANK_BYTES,
  DELAY_MIN_MS, DELAY_MAX_MS, KIND_FULL, KIND_DELTA, ERROR,
  crc32, Crc32, encodePackBits, decodePackBits, parseBlobHeader,
  decodeBlob, decodePayload, encodeFull, encodeDelta, encodeFrame, FrameDecoder,
} from '../web/anim-codec.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors-animation.json', import.meta.url)));
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const frame = index => bytes(vectors.frames[index].hex);
const nameIndex = name => {
  const index = vectors.frames.findIndex(f => f.name === name);
  assert.notEqual(index, -1, `unknown frame ${name}`);
  return index;
};

test('constants match the frozen wire contract', () => {
  assert.equal(FRAME_BYTES, 4000);
  assert.equal(FRAME_HEADER_BYTES, 8);
  assert.equal(MAX_BLOB_BYTES, 4008);
  assert.equal(MAX_FRAMES, 64);
  assert.equal(DATA_BANK_BYTES, 0xD000);
  assert.equal(DELAY_MIN_MS, 100);
  assert.equal(DELAY_MAX_MS, 60000);
  assert.equal(KIND_FULL, 0);
  assert.equal(KIND_DELTA, 1);
});

test('shared CRC vectors from tests/vectors.json pass through the animation CRC', () => {
  assert.equal(vectors.crc.length, 3);
  for (const entry of vectors.crc) assert.equal(crc32(bytes(entry.hex)), entry.value, entry.name);
  assert.equal(crc32(bytes('313233343536373839')), 0xcbf43926);
});

test('incremental Crc32 equals one-shot crc32 and is chainable', () => {
  const data = new Uint8Array(1000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
  const incremental = new Crc32();
  assert.equal(incremental.update(data.subarray(0, 1)), incremental, 'update must return the instance');
  incremental.update(data.subarray(1, 517)).update(data.subarray(517));
  assert.equal(incremental.value(), crc32(data));
  assert.equal(new Crc32().value(), 0, 'empty CRC must be zero');
});

test('frame vectors have legal padding bits and their stated CRC', () => {
  for (const [index, entry] of vectors.frames.entries()) {
    const value = frame(index);
    assert.equal(value.length, FRAME_BYTES);
    assert.equal(crc32(value), entry.crc, entry.name);
    for (let y = 0; y < 250; y++) assert.equal(value[y * 16 + 15] & 0x3f, 0, `${entry.name} row ${y} padding`);
  }
});

test('blob vectors encode, decode and round-trip byte-for-byte', () => {
  assert.ok(vectors.blobs.length >= 6);
  for (const vector of vectors.blobs) {
    const prev = vector.prev === null ? null : frame(vector.prev);
    const target = frame(vector.frame);
    const expected = bytes(vector.blobHex);
    assert.equal(expected.length, FRAME_HEADER_BYTES + vector.encLen, `${vector.name} blob length`);
    assert.equal(expected[0], vector.kind, `${vector.name} kind`);
    assert.equal(expected[1], 0, `${vector.name} reserved`);

    const encoded = encodeFrame(prev, target);
    assert.equal(hex(encoded.blob), vector.blobHex, `${vector.name} encoded bytes`);
    assert.equal(encoded.kind, vector.kind);
    assert.equal(encoded.encLen, vector.encLen);
    assert.equal(encoded.usedFull, vector.kind === KIND_FULL);

    const decoded = decodeBlob(expected, prev);
    assert.equal(decoded.kind, vector.kind);
    assert.equal(decoded.crc, vector.crc);
    assert.equal(hex(decoded.bytes), vectors.frames[vector.frame].hex, `${vector.name} decoded frame`);
  }
});

test('delta-vs-full selection rule: kind 1 only when the payload is under 4000 bytes', () => {
  const zero = frame(nameIndex('all-equal'));
  // A delta whose PackBits payload is exactly 4000 or more must fall back to kind 0.
  const incompressible = frame(nameIndex('incompressible'));
  const fallback = encodeFrame(zero, incompressible);
  assert.equal(fallback.kind, KIND_FULL);
  assert.equal(fallback.encLen, FRAME_BYTES);
  assert.equal(fallback.blob.length, MAX_BLOB_BYTES);

  // Identical all-zero frames delta to 4000 zeros: 31 runs of 128 plus a run of
  // 32, i.e. 32 two-byte tokens, well under the 4000-byte fallback threshold.
  const same = encodeFrame(zero, zero);
  assert.equal(same.kind, KIND_DELTA);
  assert.equal(same.encLen, 64);
  const expectedPayload = '8100'.repeat(31) + 'e100';
  assert.equal(hex(same.blob.subarray(FRAME_HEADER_BYTES)), expectedPayload);

  // encodeFull always produces kind 0; encodeDelta always returns a blob.
  const full = encodeFull(zero);
  assert.equal(parseBlobHeader(full).kind, KIND_FULL);
  assert.equal(hex(full.subarray(8)), vectors.frames[nameIndex('all-equal')].hex);
  assert.equal(hex(encodeDelta(zero, zero)), hex(same.blob));
});

test('PackBits edge cases match the committed vectors', () => {
  for (const vector of vectors.packbits) {
    const raw = bytes(vector.rawHex);
    assert.equal(hex(encodePackBits(raw)), vector.encodedHex, vector.name);
    assert.equal(hex(decodePackBits(bytes(vector.encodedHex), raw.length)), vector.rawHex, `${vector.name} decode`);
  }
  for (const vector of vectors.packbitsDecode) {
    const encoded = bytes(vector.encodedHex);
    assert.equal(hex(decodePackBits(encoded, bytes(vector.rawHex).length)), vector.rawHex, vector.name);
  }
  // 128 literal bytes use the maximum literal control byte.
  assert.equal(bytes(vectors.packbits[0].encodedHex)[0], 0x7f);
  // A run of exactly 3 is the shortest repeat; 2 is cheaper as a literal.
  assert.equal(vectors.packbits[2].encodedHex, 'fe07');
  assert.equal(vectors.packbits[3].encodedHex, '010707');
  // Control byte 128 is reserved and must be rejected.
  assert.throws(() => decodePackBits(Uint8Array.from([0x80]), 1), error => error.code === ERROR.STREAM);
  // Runs never exceed 128 copies, so 255 equal bytes split into 128 + 127.
  assert.equal(vectors.packbits[4].encodedHex, '81ab82ab');
});

test('decodePackBits rejects overruns, underruns and reserved controls', () => {
  const cases = [
    [[0x80], 1, ERROR.STREAM, 'reserved control 128'],
    [[0x00], 2, ERROR.STREAM, 'literal underrun'],
    [[0xff, 1], 4, ERROR.STREAM, 'repeat overrun'],
    [[0x01, 1, 2, 3], 3, ERROR.STREAM, 'too many bytes'],
    [[0x00, 1], 2, ERROR.STREAM, 'too few bytes'],
  ];
  for (const [encoded, size, code, name] of cases) {
    assert.throws(() => decodePackBits(Uint8Array.from(encoded), size), error => error.code === code, name);
  }
});

test('reject vectors fail at the stated stage with the stated code', () => {
  for (const vector of vectors.rejects) {
    const blob = bytes(vector.blobHex);
    const prev = vector.prev === null ? null : frame(vector.prev);
    if (vector.stage === 'header') {
      assert.throws(() => parseBlobHeader(blob), error => error.code === vector.error, `${vector.name} header`);
    } else {
      assert.doesNotThrow(() => parseBlobHeader(blob), `${vector.name} header must parse`);
      assert.throws(() => decodeBlob(blob, prev), error => error.code === vector.error, vector.name);
    }
  }
});

test('header parsing rejects every reserved or out-of-range field', () => {
  const good = encodeFull(frame(0));
  const mutate = (offset, value) => { const copy = Uint8Array.from(good); copy[offset] = value; return copy; };
  assert.throws(() => parseBlobHeader(mutate(1, 1)), error => error.code === ERROR.MALFORMED, 'reserved byte');
  assert.throws(() => parseBlobHeader(mutate(0, 2)), error => error.code === ERROR.MALFORMED, 'kind 2');
  assert.throws(() => parseBlobHeader(good.subarray(0, 7)), error => error.code === ERROR.MALFORMED, 'short header');
  assert.throws(() => parseBlobHeader(mutate(2, 0x9f)), error => error.code === ERROR.LENGTH, 'full encLen 3999');
  const delta = Uint8Array.from([KIND_DELTA, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => parseBlobHeader(delta), error => error.code === ERROR.LENGTH, 'delta encLen 0');
  const longDelta = Uint8Array.from([KIND_DELTA, 0, 0xa1, 0x0f, 0, 0, 0, 0]);
  assert.throws(() => parseBlobHeader(longDelta), error => error.code === ERROR.LENGTH, 'delta encLen 4001');
});

test('decodeBlob requires the exact declared length', () => {
  const blob = encodeFull(frame(0));
  assert.throws(() => decodeBlob(blob.subarray(0, blob.length - 1)), error => error.code === ERROR.LENGTH, 'short');
  const padded = new Uint8Array(blob.length + 1);
  padded.set(blob);
  assert.throws(() => decodeBlob(padded), error => error.code === ERROR.LENGTH, 'long');
});

test('decodePayload without a header decodes kind 0 and kind 1', () => {
  const zero = frame(nameIndex('all-equal'));
  const ones = frame(nameIndex('all-ones'));
  const full = decodePayload(KIND_FULL, ones);
  assert.equal(hex(full), hex(ones));
  const delta = encodePackBits(Uint8Array.from(ones.map((b, i) => b ^ zero[i])));
  const out = decodePayload(KIND_DELTA, delta, zero);
  assert.equal(hex(out), hex(ones));
  assert.throws(() => decodePayload(KIND_DELTA, delta, null), error => error.code === ERROR.MALFORMED);
  assert.throws(() => decodePayload(KIND_FULL, ones.subarray(0, 3999)), error => error.code === ERROR.LENGTH);
  assert.throws(() => decodePayload(3, ones), error => error.code === ERROR.MALFORMED);
});

test('decodePayload writes into a caller-provided buffer', () => {
  const target = frame(0);
  const out = new Uint8Array(FRAME_BYTES).fill(0xaa);
  const returned = decodePayload(KIND_FULL, target, null, out);
  assert.equal(returned, out, 'the provided buffer is returned');
  assert.equal(hex(out), hex(target));
  assert.throws(() => decodePayload(KIND_FULL, target, null, new Uint8Array(10)), error => error.code === ERROR.MALFORMED);
});

test('animation CRC is the CRC over concatenated decoded frames in index order', () => {
  for (const vector of vectors.animations) {
    const crc = new Crc32();
    for (const index of vector.frames) crc.update(frame(index));
    assert.equal(crc.value(), vector.crc, vector.name);

    // Feeding blobs through FrameDecoder must reproduce the same animation CRC.
    const decoder = new FrameDecoder();
    const animation = new Crc32();
    let prev = null;
    for (const index of vector.frames) {
      const encoded = encodeFrame(prev, frame(index));
      const pushed = decoder.push(encoded.blob, 100);
      animation.update(pushed.bytes);
      assert.equal(hex(pushed.bytes), vectors.frames[index].hex, `${vector.name} frame ${index}`);
      prev = frame(index);
    }
    assert.equal(animation.value(), vector.crc, `${vector.name} incremental`);
  }
});

test('FrameDecoder reproduces a mixed-kind sequence and survives reset', () => {
  const decoder = new FrameDecoder();
  const first = decoder.push(encodeFrame(null, frame(0)).blob, 120);
  assert.equal(first.kind, KIND_FULL);
  assert.equal(first.delayMs, 120);
  assert.equal(decoder.index, 0);
  const second = decoder.push(encodeFrame(frame(0), frame(1)).blob, 100);
  assert.equal(second.kind, KIND_DELTA);
  assert.equal(hex(second.bytes), vectors.frames[1].hex);
  assert.equal(decoder.index, 1);
  decoder.reset();
  assert.equal(decoder.index, -1);
  assert.equal(decoder.previous, null);
  assert.throws(() => decoder.push(encodeFrame(frame(0), frame(1)).blob), error => error.code === ERROR.MALFORMED, 'delta after reset has no previous frame');
});

test('FrameDecoder keeps a stable previous buffer across pushes', () => {
  const decoder = new FrameDecoder();
  decoder.push(encodeFrame(null, frame(0)).blob);
  const snapshot = hex(decoder.previous);
  decoder.push(encodeFrame(frame(0), frame(1)).blob);
  assert.equal(snapshot, vectors.frames[0].hex, 'previous frame must not be overwritten in place');
  assert.equal(hex(decoder.previous), vectors.frames[1].hex);
});

test('encodeFrame rejects malformed frames', () => {
  assert.throws(() => encodeFrame(null, new Uint8Array(10)), error => error.code === ERROR.LENGTH);
  assert.throws(() => encodeFrame(new Uint8Array(3999), frame(0)), error => error.code === ERROR.LENGTH);
  assert.throws(() => encodeFull([1, 2, 3]), error => error.code === ERROR.LENGTH);
  assert.throws(() => encodeFrame(null, 'frame'), error => error.code === ERROR.LENGTH);
});

test('committed vectors are reproducible from the generator', () => {
  execFileSync(process.execPath, [new URL('./fixtures/animation/make-vectors.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
});

test('committed GIF fixtures are reproducible from the generator', () => {
  execFileSync(process.execPath, [new URL('./fixtures/animation/make-gif.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
});
