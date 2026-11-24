// Animation frame codec shared by the editor, the player and the host tests.
// Spec: docs/protocol-animation.md. Byte layouts here are frozen; changing them
// requires updating tests/vectors-animation.json and firmware/include/anim_codec.h.
//
// A frame blob is `kind:u8 reserved:u8=0 encLen:u16 crc:u32 payload[encLen]`
// (little-endian), total 8 + encLen bytes, where:
//   kind 0 (full)  payload is the 4000 decoded bytes verbatim (encLen == 4000)
//   kind 1 (delta) payload is PackBits(frame XOR previous decoded frame)
// `crc` is IEEE CRC32 (0xEDB88320, init/final 0xFFFFFFFF) of the 4000 decoded bytes.
import { crc32, WIDTH, HEIGHT, STRIDE, FRAME_BYTES } from './image.js';
export { WIDTH, HEIGHT, STRIDE, FRAME_BYTES, crc32 };

export const MAX_FRAMES = 64;
export const FRAME_HEADER_BYTES = 8;
export const MAX_BLOB_BYTES = FRAME_HEADER_BYTES + FRAME_BYTES;
// One data bank is 13 erase sectors of 4096 bytes; both banks together are 0x1A000.
export const DATA_BANK_BYTES = 0xD000;
export const DELAY_MIN_MS = 100;
export const DELAY_MAX_MS = 60000;
export const KIND_FULL = 0;
export const KIND_DELTA = 1;
// Numeric codes match eink::anim::Status in firmware/include/anim_codec.h.
export const ERROR = Object.freeze({ MALFORMED: 1, LENGTH: 2, CRC: 3, STREAM: 4 });

export class AnimCodecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnimCodecError';
    this.code = code;
  }
}

const reject = (code, message) => { throw new AnimCodecError(code, message); };
const isFrame = value => value instanceof Uint8Array && value.length === FRAME_BYTES;

// Incremental CRC32 so the animation CRC can be folded over frames as they decode.
export class Crc32 {
  constructor() { this.state = 0xffffffff; }
  update(bytes) {
    let crc = this.state;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    this.state = crc;
    return this;
  }
  value() { return (this.state ^ 0xffffffff) >>> 0; }
}

// PackBits, identical to the protocol v2 subset in web/ble.js.
// 0..127 = literal run of control+1 bytes, 128 forbidden, 129..255 = repeat of
// 257-control copies of the next byte. The encoder starts repeats at 3 because a
// repeat of length 2 costs two bytes either way.
export function encodePackBits(raw) {
  const out = [];
  for (let i = 0; i < raw.length;) {
    let run = 1;
    while (run < 128 && i + run < raw.length && raw[i + run] === raw[i]) run++;
    if (run >= 3) { out.push(257 - run, raw[i]); i += run; continue; }
    const start = i;
    while (i < raw.length && i - start < 128) {
      if (i + 2 < raw.length && raw[i] === raw[i + 1] && raw[i] === raw[i + 2]) break;
      i++;
    }
    out.push(i - start - 1);
    for (let j = start; j < i; j++) out.push(raw[j]);
  }
  return Uint8Array.from(out);
}

// Strict PackBits decoder. Any token error, a 128 control byte, or a stream that
// does not produce exactly `size` bytes is a stream error.
export function decodePackBits(encoded, size = FRAME_BYTES) {
  if (!(encoded instanceof Uint8Array)) reject(ERROR.MALFORMED, 'encoded payload must be a Uint8Array');
  const out = new Uint8Array(size);
  let i = 0, produced = 0;
  while (i < encoded.length) {
    const control = encoded[i++];
    if (control < 128) {
      const count = control + 1;
      if (i + count > encoded.length || produced + count > size) reject(ERROR.STREAM, 'literal run overruns the stream or frame');
      out.set(encoded.subarray(i, i + count), produced);
      i += count; produced += count;
    } else if (control === 128) {
      reject(ERROR.STREAM, 'PackBits control byte 128 is reserved');
    } else {
      const count = 257 - control;
      if (i >= encoded.length || produced + count > size) reject(ERROR.STREAM, 'repeat run overruns the stream or frame');
      out.fill(encoded[i++], produced, produced + count);
      produced += count;
    }
  }
  if (produced !== size) reject(ERROR.STREAM, `stream produced ${produced} of ${size} bytes`);
  return out;
}

// Header-only parse: does not require the payload to be present.
export function parseBlobHeader(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < FRAME_HEADER_BYTES) reject(ERROR.MALFORMED, 'blob shorter than 8 bytes');
  const kind = blob[0], reserved = blob[1], encLen = blob[2] | (blob[3] << 8);
  const crc = (blob[4] | (blob[5] << 8) | (blob[6] << 16) | (blob[7] << 24)) >>> 0;
  if (reserved !== 0) reject(ERROR.MALFORMED, 'blob reserved byte must be zero');
  if (kind > KIND_DELTA) reject(ERROR.MALFORMED, 'unknown blob kind');
  if (kind === KIND_FULL && encLen !== FRAME_BYTES) reject(ERROR.LENGTH, 'full frame encLen must be 4000');
  if (kind === KIND_DELTA && (encLen < 1 || encLen > FRAME_BYTES)) reject(ERROR.LENGTH, 'delta encLen must be 1..4000');
  return { kind, reserved, encLen, crc };
}

// Decode a payload without a header: no CRC check is possible here.
// `out` is an optional caller-owned 4000-byte destination buffer.
export function decodePayload(kind, payload, prev, out = new Uint8Array(FRAME_BYTES)) {
  if (!(payload instanceof Uint8Array)) reject(ERROR.MALFORMED, 'payload must be a Uint8Array');
  if (!(out instanceof Uint8Array) || out.length !== FRAME_BYTES) reject(ERROR.MALFORMED, 'out must be a 4000-byte Uint8Array');
  if (kind === KIND_FULL) {
    if (payload.length !== FRAME_BYTES) reject(ERROR.LENGTH, 'full payload must be 4000 bytes');
    out.set(payload);
    return out;
  }
  if (kind !== KIND_DELTA) reject(ERROR.MALFORMED, 'unknown blob kind');
  if (!isFrame(prev)) reject(ERROR.MALFORMED, 'delta payload requires a previous 4000-byte frame');
  const delta = decodePackBits(payload, FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) out[i] = delta[i] ^ prev[i];
  return out;
}

// Full blob decode: header, length, stream, CRC, and (for deltas) the XOR.
export function decodeBlob(blob, prev = null, out = new Uint8Array(FRAME_BYTES)) {
  const header = parseBlobHeader(blob);
  if (blob.length !== FRAME_HEADER_BYTES + header.encLen) reject(ERROR.LENGTH, `blob length ${blob.length} != 8 + encLen ${header.encLen}`);
  const bytes = decodePayload(header.kind, blob.subarray(FRAME_HEADER_BYTES), header.kind === KIND_DELTA ? prev : null, out);
  if (crc32(bytes) !== header.crc) reject(ERROR.CRC, 'decoded frame CRC does not match the blob header');
  return { kind: header.kind, encLen: header.encLen, crc: header.crc, bytes };
}

function writeHeader(blob, kind, encLen, crc) {
  blob[0] = kind; blob[1] = 0;
  blob[2] = encLen & 0xff; blob[3] = (encLen >>> 8) & 0xff;
  blob[4] = crc & 0xff; blob[5] = (crc >>> 8) & 0xff;
  blob[6] = (crc >>> 16) & 0xff; blob[7] = (crc >>> 24) & 0xff;
}

export function encodeFull(frame) {
  if (!isFrame(frame)) reject(ERROR.LENGTH, 'frame must be a 4000-byte Uint8Array');
  const blob = new Uint8Array(MAX_BLOB_BYTES);
  writeHeader(blob, KIND_FULL, FRAME_BYTES, crc32(frame));
  blob.set(frame, FRAME_HEADER_BYTES);
  return blob;
}

const deltaOf = (prev, frame) => {
  const delta = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) delta[i] = prev[i] ^ frame[i];
  return delta;
};

// Always emits kind 1 when it encodes to fewer than 4000 payload bytes, and
// falls back to kind 0 otherwise (including the degenerate 4096-byte worst case,
// which would not fit the wire's 4000-byte encoded limit).
export function encodeDelta(prev, frame) {
  if (!isFrame(prev) || !isFrame(frame)) reject(ERROR.LENGTH, 'both frames must be 4000-byte Uint8Arrays');
  const payload = encodePackBits(deltaOf(prev, frame));
  if (payload.length >= FRAME_BYTES) return encodeFull(frame);
  const blob = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  writeHeader(blob, KIND_DELTA, payload.length, crc32(frame));
  blob.set(payload, FRAME_HEADER_BYTES);
  return blob;
}

// The single upload-side entry point: a null previous frame means kind 0.
export function encodeFrame(prev, frame) {
  const blob = prev == null ? encodeFull(frame) : encodeDelta(prev, frame);
  const { kind, encLen, crc } = parseBlobHeader(blob);
  return { kind, blob, usedFull: kind === KIND_FULL, encLen, crc };
}

// Holds the previous decoded frame and one scratch buffer, mirroring the two
// static 4000-byte buffers the firmware uses. push() returns a fresh copy so a
// caller may retain it while the next frame decodes; `.previous` is zero-copy
// and is only valid until the next push().
export class FrameDecoder {
  constructor() {
    this.previous = null;
    this.a = new Uint8Array(FRAME_BYTES);
    this.b = new Uint8Array(FRAME_BYTES);
    this.count = 0;
  }
  reset() { this.previous = null; this.count = 0; }
  push(blob, delayMs = null) {
    const { kind, crc, encLen, bytes } = decodeBlob(blob, this.previous, this.b);
    const copy = Uint8Array.from(bytes);
    const spent = this.b;
    this.b = this.a;
    this.a = spent;
    this.previous = spent;
    this.count++;
    return { kind, crc, encLen, delayMs, bytes: copy };
  }
  get index() { return this.count - 1; }
}
