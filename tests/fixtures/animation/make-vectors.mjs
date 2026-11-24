#!/usr/bin/env node
// Deterministic animation codec vectors shared by tests/anim-codec.test.js,
// tests/anim_codec.cpp and (for schema) the firmware's own generator.
//
//   node tests/fixtures/animation/make-vectors.mjs          # rewrite vectors-animation.json
//   node tests/fixtures/animation/make-vectors.mjs --check   # fail if the committed file is stale
//
// Expected values are computed here with independent reference implementations
// (table-driven CRC32, a separately written PackBits encoder) and then asserted
// against web/anim-codec.js, so the committed file is not a copy of the module
// under test.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRAME_BYTES, MAX_FRAMES, DELAY_MIN_MS, DELAY_MAX_MS, KIND_FULL, KIND_DELTA,
  crc32, encodeFrame, encodeFull, decodeBlob, parseBlobHeader, encodePackBits,
} from '../../../web/anim-codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, '..', '..', 'vectors-animation.json');

// ------------------------------------------------------------ reference CRC32
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function refCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --------------------------------------------------------- reference PackBits
// Written independently of the module: same published token rules, different code.
function refPackBits(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const value = raw[i];
    let run = 1;
    while (run < 128 && i + run < raw.length && raw[i + run] === value) run++;
    if (run >= 3) {
      out.push(257 - run, value);
      i += run;
      continue;
    }
    const literals = [];
    while (i < raw.length && literals.length < 128) {
      const next3 = i + 2 < raw.length && raw[i] === raw[i + 1] && raw[i] === raw[i + 2];
      if (next3) break;
      literals.push(raw[i++]);
    }
    out.push(literals.length - 1, ...literals);
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------- fixtures
const hex = bytes => Buffer.from(bytes).toString('hex');
const fromHex = text => Uint8Array.from(Buffer.from(text, 'hex'));

// Zero the six padding bits of every row's last byte so vectors are legal frames.
const legalFrame = bytes => {
  const frame = Uint8Array.from(bytes);
  for (let y = 0; y < 250; y++) frame[y * 16 + 15] &= 0xc0;
  return frame;
};

function pseudoRandom(count, seed) {
  const out = new Uint8Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const frames = [
  { name: 'synthetic', hex: hex(legalFrame(pseudoRandom(FRAME_BYTES, 0x12345678))) },
  { name: 'inverted', hex: hex(legalFrame(pseudoRandom(FRAME_BYTES, 0x12345678).map(b => b ^ 0xff))) },
  { name: 'sparse', hex: hex(legalFrame((() => {
    const frame = new Uint8Array(FRAME_BYTES);
    for (let y = 40; y < 120; y++) for (let x = 20; x < 80; x++) frame[y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
    for (let y = 200; y < 205; y++) for (let x = 0; x < 122; x++) frame[y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
    return frame;
  })())) },
  { name: 'all-equal', hex: hex(new Uint8Array(FRAME_BYTES)) },
  { name: 'incompressible', hex: hex(legalFrame(pseudoRandom(FRAME_BYTES, 0xdeadbeef))) },
  { name: 'all-ones', hex: hex(legalFrame(new Uint8Array(FRAME_BYTES).fill(0xff))) },
  { name: 'gradient', hex: hex(legalFrame((() => {
    const frame = new Uint8Array(FRAME_BYTES);
    for (let y = 0; y < 250; y++) for (let x = 0; x < 122; x++) if ((x * 3 + y * 5) % 32 < 9) frame[y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
    return frame;
  })())) },
];

// Frames are addressed by name so reordering the frame table cannot silently
// change what a vector means.
const blobSpecs = [
  { name: 'full-synthetic', prev: null, frame: 'synthetic' },
  { name: 'delta-inverted', prev: 'synthetic', frame: 'inverted' },
  { name: 'delta-sparse-from-zero', prev: 'all-equal', frame: 'sparse' },
  { name: 'full-all-equal', prev: null, frame: 'all-equal' },
  { name: 'incompressible-falls-back-to-full', prev: 'all-equal', frame: 'incompressible' },
  { name: 'delta-gradient-from-zero', prev: 'all-equal', frame: 'gradient' },
  { name: 'delta-all-ones-best-run', prev: 'all-equal', frame: 'all-ones' },
];

const animationSpecs = [
  { name: 'three-frame-sequence', frames: ['synthetic', 'inverted', 'sparse'] },
  { name: 'mixed-kinds', frames: ['synthetic', 'all-equal', 'all-ones'] },
  { name: 'single-frame', frames: ['all-equal'] },
];

// ------------------------------------------------------------- packbits cases
const distinct = (n, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) % 251);
const repeated = (n, value) => new Uint8Array(n).fill(value);

const packbitsSpecs = [
  { name: 'literal-128-max', raw: distinct(128) },
  { name: 'literal-129-splits-at-128', raw: distinct(129) },
  { name: 'repeat-3-minimum', raw: repeated(3, 7) },
  { name: 'repeat-2-encodes-as-literal', raw: repeated(2, 7) },
  { name: 'repeat-255-splits-at-128', raw: repeated(255, 0xab) },
  { name: 'repeat-300', raw: repeated(300, 0xab) },
  { name: 'mixed-literals-and-runs', raw: Uint8Array.from([1, 1, 1, 2, 3, 4, 4, 4, 4]) },
  { name: 'no-three-run-boundary', raw: Uint8Array.from([9, 9, 8, 8, 9, 9, 8, 8]) },
];

// Each pattern is also repeated to a full 4000-byte delta so the C++ header,
// whose PackBits path is frame-sized only, can exercise the same edge cases
// through encodeDelta(zeros, delta).
const packbitsFrameSpecs = packbitsSpecs.map(spec => {
  const delta = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) delta[i] = spec.raw[i % spec.raw.length];
  return { name: `delta-${spec.name}`, delta };
});

const packbitsDecodeSpecs = [
  { name: 'repeat-2-accepted-by-decoder', encoded: Uint8Array.from([0xff, 9]) },
  { name: 'literal-then-repeat', encoded: Uint8Array.from([0x00, 5, 0xfe, 6]) },
  { name: 'run-128', encoded: Uint8Array.from([0x81, 0x22]) },
];

// ------------------------------------------------------------------- rejects
const blobWith = (kind, payload, crc) => {
  const blob = new Uint8Array(8 + payload.length);
  blob[0] = kind; blob[1] = 0;
  blob[2] = payload.length & 0xff; blob[3] = (payload.length >>> 8) & 0xff;
  blob[4] = crc & 0xff; blob[5] = (crc >>> 8) & 0xff; blob[6] = (crc >>> 16) & 0xff; blob[7] = (crc >>> 24) & 0xff;
  blob.set(payload, 8);
  return blob;
};

function rejects() {
  const good = encodeFull(fromHex(frames[0].hex));
  const corrupt = Uint8Array.from(good);
  corrupt[4] ^= 0xff; // flip one bit of the stored CRC
  const truncated = good.subarray(0, 100);
  const badControl = blobWith(KIND_DELTA, Uint8Array.from([0x80]), refCrc32(fromHex(frames[0].hex)));
  const reserved = Uint8Array.from(good); reserved[1] = 1;
  const kindTwo = Uint8Array.from(good); kindTwo[0] = 2;
  const shortFull = blobWith(KIND_FULL, new Uint8Array(3999), 0);
  const emptyDelta = blobWith(KIND_DELTA, new Uint8Array(0), 0);
  const longFull = blobWith(KIND_FULL, new Uint8Array(4001), 0);
  const shortBlob = Uint8Array.from(good.subarray(0, 7));
  const deltaNoPrev = blobWith(KIND_DELTA, Uint8Array.from([0x00, 0x41]), refCrc32(fromHex(frames[0].hex)));
  const streamUnderflow = blobWith(KIND_DELTA, Uint8Array.from([0x05, 1, 2, 3]), 0);
  const streamShort = blobWith(KIND_DELTA, Uint8Array.from([0xff, 0x41]), 0);
  return [
    { name: 'truncated-payload', blob: truncated, error: 2, stage: 'decode', prev: 'synthetic' },
    { name: 'corrupt-crc', blob: corrupt, error: 3, stage: 'decode', prev: 'synthetic' },
    { name: 'packbits-control-128', blob: badControl, error: 4, stage: 'decode', prev: 'synthetic' },
    { name: 'reserved-nonzero', blob: reserved, error: 1, stage: 'header', prev: 'synthetic' },
    { name: 'unknown-kind', blob: kindTwo, error: 1, stage: 'header', prev: 'synthetic' },
    { name: 'full-encLen-3999', blob: shortFull, error: 2, stage: 'header', prev: 'synthetic' },
    { name: 'delta-encLen-zero', blob: emptyDelta, error: 2, stage: 'header', prev: 'synthetic' },
    { name: 'full-encLen-4001', blob: longFull, error: 2, stage: 'header', prev: 'synthetic' },
    { name: 'shorter-than-header', blob: shortBlob, error: 1, stage: 'header', prev: 'synthetic' },
    { name: 'delta-without-previous', blob: deltaNoPrev, error: 1, stage: 'decode', prev: null },
    { name: 'stream-literal-underflow', blob: streamUnderflow, error: 4, stage: 'decode', prev: 'synthetic' },
    { name: 'stream-too-short', blob: streamShort, error: 4, stage: 'decode', prev: 'synthetic' },
  ];
}

// ------------------------------------------------------------------- assemble
export function build() {
  const frameBytes = frames.map(f => fromHex(f.hex));
  const indexOf = name => {
    const index = frames.findIndex(f => f.name === name);
    if (index < 0) throw new Error(`unknown frame name ${name}`);
    return index;
  };
  const frameEntries = frames.map((f, i) => ({ name: f.name, hex: f.hex, crc: refCrc32(frameBytes[i]) }));

  const blobs = blobSpecs.map(spec => {
    const prevIndex = spec.prev === null ? null : indexOf(spec.prev);
    const frameIndex = indexOf(spec.frame);
    const prev = prevIndex === null ? null : frameBytes[prevIndex];
    const frame = frameBytes[frameIndex];
    const referencePayload = refPackBits(prev ? Uint8Array.from(frame.map((b, i) => b ^ prev[i])) : frame);
    const encoded = encodeFrame(prev, frame);
    const expectedKind = prev === null || referencePayload.length >= FRAME_BYTES ? KIND_FULL : KIND_DELTA;
    const expectedLen = expectedKind === KIND_FULL ? FRAME_BYTES : referencePayload.length;
    if (encoded.kind !== expectedKind) throw new Error(`${spec.name}: kind ${encoded.kind} != reference ${expectedKind}`);
    if (encoded.encLen !== expectedLen) throw new Error(`${spec.name}: encLen ${encoded.encLen} != reference ${expectedLen}`);
    if (encoded.crc !== refCrc32(frame)) throw new Error(`${spec.name}: frame CRC mismatch`);
    const header = parseBlobHeader(encoded.blob);
    if (header.kind !== expectedKind || header.encLen !== expectedLen) throw new Error(`${spec.name}: header mismatch`);
    const roundTrip = decodeBlob(encoded.blob, prev);
    if (!Buffer.from(roundTrip.bytes).equals(Buffer.from(frame))) throw new Error(`${spec.name}: round trip mismatch`);
    if (expectedKind === KIND_DELTA && !Buffer.from(encoded.blob.subarray(8)).equals(Buffer.from(referencePayload)))
      throw new Error(`${spec.name}: delta payload differs from the reference encoder`);
    return { name: spec.name, prev: prevIndex, frame: frameIndex, kind: expectedKind, encLen: expectedLen,
      crc: refCrc32(frame), blobHex: hex(encoded.blob) };
  });

  const animations = animationSpecs.map(spec => {
    let crc = 0xffffffff;
    const indices = spec.frames.map(indexOf);
    for (const index of indices) crc = updateRef(crc, frameBytes[index]);
    return { name: spec.name, frames: indices, crc: (crc ^ 0xffffffff) >>> 0 };
  });

  const packbits = packbitsSpecs.map(spec => {
    const expected = refPackBits(spec.raw);
    const actual = encodePackBits(spec.raw);
    if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`${spec.name}: encoder differs from the reference`);
    return { name: spec.name, rawHex: hex(spec.raw), encodedHex: hex(expected) };
  });

  const packbitsFrames = packbitsFrameSpecs.map(spec => {
    const expected = refPackBits(spec.delta);
    const actual = encodePackBits(spec.delta);
    if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`${spec.name}: encoder differs from the reference`);
    const zero = new Uint8Array(FRAME_BYTES);
    const encoded = encodeFrame(zero, spec.delta);
    if (encoded.kind !== (expected.length < FRAME_BYTES ? KIND_DELTA : KIND_FULL)) throw new Error(`${spec.name}: kind mismatch`);
    if (expected.length < FRAME_BYTES &&
        !Buffer.from(encoded.blob.subarray(8)).equals(Buffer.from(expected))) throw new Error(`${spec.name}: payload mismatch`);
    return { name: spec.name, deltaHex: hex(spec.delta), encodedHex: hex(expected) };
  });

  const packbitsDecode = packbitsDecodeSpecs.map(spec => {
    const raw = refUnpackBits(spec.encoded, expectedLength(spec.encoded));
    return { name: spec.name, encodedHex: hex(spec.encoded), rawHex: hex(raw) };
  });

  const indexOfName = name => frames.findIndex(f => f.name === name);
  const rejectEntries = rejects().map(spec => {
    const stage = spec.stage;
    let headerOk = true;
    try { parseBlobHeader(spec.blob); } catch { headerOk = false; }
    if (stage === 'header' && headerOk) throw new Error(`${spec.name}: parseBlobHeader accepted a rejected blob`);
    const prev = spec.prev === null ? null : fromHex(frames[indexOfName(spec.prev)].hex);
    if (stage === 'decode') {
      if (!headerOk) throw new Error(`${spec.name}: header should parse before the decode-stage failure`);
      let code = null;
      try { decodeBlob(spec.blob, prev); } catch (error) { code = error.code; }
      if (code !== spec.error) throw new Error(`${spec.name}: decodeBlob error ${code} != ${spec.error}`);
    }
    return { name: spec.name, blobHex: hex(spec.blob), error: spec.error, stage,
      prev: spec.prev === null ? null : indexOfName(spec.prev) };
  });

  return {
    note: 'Generated by tests/fixtures/animation/make-vectors.mjs from independent reference implementations; see docs/protocol-animation.md.',
    frameBytes: FRAME_BYTES, maxFrames: MAX_FRAMES, delayMinMs: DELAY_MIN_MS, delayMaxMs: DELAY_MAX_MS,
    crc: sharedCrc(),
    frames: frameEntries,
    blobs,
    animations,
    packbits,
    packbitsFrames,
    packbitsDecode,
    rejects: rejectEntries,
  };
}

// The same CRC vectors tests/vectors.json already pins for protocol.h and image.js,
// so both codecs must agree with the legacy implementations too.
function sharedCrc() {
  const shared = JSON.parse(readFileSync(join(HERE, '..', '..', 'vectors.json'), 'utf8'));
  return shared.crc.map((entry, index) => {
    const bytes = fromHex(entry.hex);
    const value = refCrc32(bytes);
    if (value !== entry.value) throw new Error(`shared CRC vector ${index} disagrees with the reference table`);
    if (crc32(bytes) !== value) throw new Error(`shared CRC vector ${index} disagrees with web/anim-codec.js`);
    return { name: `shared-${index}`, hex: entry.hex, value };
  });
}

// Reference decoders used only to build the packbitsDecode expectations.
function expectedLength(encoded) {
  let length = 0;
  for (let i = 0; i < encoded.length;) {
    const control = encoded[i++];
    if (control < 128) { length += control + 1; i += control + 1; }
    else if (control === 128) throw new Error('reserved control byte in a decode vector');
    else { length += 257 - control; i += 1; }
  }
  return length;
}
function refUnpackBits(encoded, size) {
  const out = new Uint8Array(size);
  let i = 0, produced = 0;
  while (i < encoded.length) {
    const control = encoded[i++];
    if (control < 128) {
      for (let n = 0; n <= control; n++) out[produced++] = encoded[i++];
    } else {
      const value = encoded[i++];
      for (let n = 0; n < 257 - control; n++) out[produced++] = value;
    }
  }
  if (produced !== size) throw new Error(`reference decoder produced ${produced} of ${size}`);
  return out;
}
function updateRef(state, bytes) {
  let crc = state;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function main() {
  const check = process.argv.includes('--check');
  const text = JSON.stringify(build(), null, 2) + '\n';
  if (check) {
    if (!existsSync(OUTPUT)) { console.error(`missing ${OUTPUT}`); process.exitCode = 1; return; }
    if (readFileSync(OUTPUT, 'utf8') !== text) {
      console.error('tests/vectors-animation.json is stale; run node tests/fixtures/animation/make-vectors.mjs');
      process.exitCode = 1;
      return;
    }
    console.log('animation vectors match the generator');
    return;
  }
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT} (${text.length} bytes)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
