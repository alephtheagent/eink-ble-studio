// Animation panel: GIF import, per-frame 1-bit conversion, e-ink preview,
// transfer statistics, throttling and the service 7b1e0010 animation wire.
//
// The conversion pipeline deliberately calls exactly what the static editor
// calls (renderGray + packBits from image.js), so a PNG and a GIF frame with
// identical pixels and identical settings produce byte-identical 4000-byte
// frames. tests/anim-gif.test.js proves that.
import { WIDTH, HEIGHT, FRAME_BYTES, renderGray, packBits, unpackBits, crc32 } from './image.js';
import { UUIDS, decodeCapabilities } from './ble.js';
import { t, subscribeLanguage } from './i18n.js';
import { decodeGif, GifError, GIF_MAX_FRAMES, GIF_FLOOR_DELAY_MS, GIF_MIN_DELAY_MS, GIF_MAX_DELAY_MS } from './anim-gif.js';
import { encodeFrame, FrameDecoder, FRAME_HEADER_BYTES } from './anim-codec.js';

export { GIF_MAX_FRAMES, GIF_FLOOR_DELAY_MS, GIF_MIN_DELAY_MS, GIF_MAX_DELAY_MS };
// Transfer estimate assumption: every acknowledged command is one
// write-with-response plus one 20-byte status read on the same connection.
// 30 ms is a deliberately conservative BLE figure (7.5 ms connection interval
// plus stack overhead). The progress bar reports real time; this number is only
// the pre-flight estimate.
export const PER_OPERATION_MS = 30;
// MTU 23 => ATT payload 20 bytes when the device reports no capabilities.
export const FALLBACK_SAFE_WRITE = 20;
export const MAX_KEEP = 8;
// PLAY start value meaning "resume the last persisted position, else frame 0".
export const PLAY_RESUME = 0xffff;
// READ returns offset:u16 + payload in a 20-byte characteristic: 18 payload bytes.
export const READ_PAYLOAD = 18;
// decodeGif() defaults to the wire limit of 64 frames. The panel decodes up to
// 128 so "keep every Nth frame" can bring a longer GIF under the limit instead
// of refusing it outright; 128 full-screen RGBA frames is about 15 MB.
export const UI_IMPORT_MAX_FRAMES = 128;

export const ANIM_OP = Object.freeze({
  INFO: 0x01, BEGIN: 0x02, FRAME: 0x03, DATA: 0x04, FRAME_COMMIT: 0x05, COMMIT: 0x06,
  PLAY: 0x07, STOP: 0x08, DELETE: 0x09, READ: 0x0a, ABORT: 0x0c
});
const ANIM_ERROR_KEYS = [
  'anim.error.ok', 'anim.error.malformed', 'anim.error.busy', 'anim.error.notFound',
  'anim.error.conflict', 'anim.error.full', 'anim.error.crc', 'anim.error.storage',
  'anim.error.offset', 'anim.error.padding', 'anim.error.codec', 'anim.error.limit'
];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const isGif = file => /^image\/gif\b/.test(file?.type || '') || /\.gif$/i.test(file?.name || '');
export { isGif };

// ---------------------------------------------------------------- pure math

export function effectiveDelay(frame, minDelayMs = GIF_MIN_DELAY_MS) {
  const floor = clamp(Math.round(Number(minDelayMs) || GIF_MIN_DELAY_MS), GIF_MIN_DELAY_MS, GIF_MAX_DELAY_MS);
  const requested = Number(frame?.delayMs ?? frame?.rawDelayMs ?? 0) || 0;
  return clamp(Math.max(requested, floor, GIF_FLOOR_DELAY_MS), GIF_MIN_DELAY_MS, GIF_MAX_DELAY_MS);
}

// Keeps every Nth frame (1 = all). Kept frames keep their own delay; the
// preview and the wire clamp it with effectiveDelay().
export function throttleFrames(frames, keepEvery = 1) {
  const step = clamp(Math.round(Number(keepEvery) || 1), 1, MAX_KEEP);
  const kept = [];
  for (let i = 0; i < frames.length; i += step) kept.push(frames[i]);
  return { frames: kept, step, dropped: frames.length - kept.length };
}

export function animationCrc(frames) {
  const all = new Uint8Array(frames.length * FRAME_BYTES);
  frames.forEach((frame, i) => all.set(frame instanceof Uint8Array ? frame : Uint8Array.from(frame), i * FRAME_BYTES));
  return crc32(all);
}

export function planOperations(blobLengths, { safeWrite = FALLBACK_SAFE_WRITE, verify = false, play = true } = {}) {
  const payloadMax = Math.max(1, safeWrite - 3);
  // READ returns offset:u16 plus at most 18 payload bytes, whatever the write
  // ceiling is, because the data characteristic is capped at 20 bytes.
  const readPayload = READ_PAYLOAD;
  // Acknowledged request() round trips: BEGIN, COMMIT, PLAY, per frame
  // FRAME + FRAME_COMMIT + ceil(blob / payloadMax) DATA, and READ chunks when
  // verification is on.
  let ops = 2 + (play ? 1 : 0);
  for (const len of blobLengths) ops += 2 + Math.ceil(len / payloadMax);
  if (verify) for (const len of blobLengths) ops += Math.ceil(len / readPayload);
  return { ops, payloadMax, readPayload };
}

export function estimateStats(blobLengths, { safeWrite = FALLBACK_SAFE_WRITE, verify = false, perOperationMs = PER_OPERATION_MS, play = true } = {}) {
  const count = blobLengths.length;
  const encodedBytes = blobLengths.reduce((sum, len) => sum + len, 0);
  const rawBytes = count * FRAME_BYTES;
  const { ops, payloadMax } = planOperations(blobLengths, { safeWrite, verify, play });
  return {
    count, encodedBytes, rawBytes,
    ratio: encodedBytes ? rawBytes / encodedBytes : 0,
    ops, payloadMax, safeWrite, perOperationMs,
    timeMs: ops * perOperationMs
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

// ------------------------------------------------------------- wire commands

// The animation panel is its own GATT service; the editor's 7b1e0001 service
// only supplies the capability characteristic used for the transfer estimate.
export const ANIM_UUIDS = Object.freeze({
  service: UUIDS.anim,
  command: '7b1e0011-6ba2-4f25-8ac7-1d54e91a1000',
  status: '7b1e0012-6ba2-4f25-8ac7-1d54e91a1000',
  data: '7b1e0013-6ba2-4f25-8ac7-1d54e91a1000'
});

export function packetInfo() { return Uint8Array.of(ANIM_OP.INFO); }
export function packetBegin(expectedRev, count, flags, crc) {
  const bytes = new Uint8Array(13), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.BEGIN;
  view.setUint32(1, expectedRev >>> 0, true);
  view.setUint16(5, count, true);
  view.setUint16(7, flags, true);
  view.setUint32(9, crc >>> 0, true);
  return bytes;
}
export function packetFrame(index, kind, encLen, crc, delayMs) {
  const bytes = new Uint8Array(13), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.FRAME;
  view.setUint16(1, index, true);
  bytes[3] = kind;
  bytes[4] = 0; // reserved
  view.setUint16(5, encLen, true);
  view.setUint32(7, crc >>> 0, true);
  view.setUint16(11, delayMs, true);
  return bytes;
}
export function packetData(offset, payload) {
  const bytes = new Uint8Array(3 + payload.length), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.DATA;
  view.setUint16(1, offset, true);
  bytes.set(payload, 3);
  return bytes;
}
export const packetFrameCommit = () => Uint8Array.of(ANIM_OP.FRAME_COMMIT);
export const packetCommit = () => Uint8Array.of(ANIM_OP.COMMIT);
export const packetAbort = () => Uint8Array.of(ANIM_OP.ABORT);
export const packetStop = () => Uint8Array.of(ANIM_OP.STOP);
export function packetPlay(start = 0) {
  const bytes = new Uint8Array(3), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.PLAY; view.setUint16(1, start, true); return bytes;
}
export function packetDelete(expectedRev) {
  const bytes = new Uint8Array(5), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.DELETE; view.setUint32(1, expectedRev >>> 0, true); return bytes;
}
export function packetRead(index, offset) {
  const bytes = new Uint8Array(5), view = new DataView(bytes.buffer);
  bytes[0] = ANIM_OP.READ; view.setUint16(1, index, true); view.setUint16(3, offset, true); return bytes;
}

export function decodeAnimStatus(bytes) {
  const view = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength !== 20) throw new Error(t('anim.invalidStatus'));
  if (view.getUint8(0) !== 1) throw new Error(t('anim.invalidStatus'));
  if (view.getUint8(3) & ~0x03) throw new Error(t('anim.invalidStatus'));
  const flags = view.getUint8(3);
  return {
    version: 1,
    op: view.getUint8(1),
    error: view.getUint8(2),
    flags,
    pending: !!(flags & 0x01),
    playing: !!(flags & 0x02),
    revision: view.getUint32(4, true),
    count: view.getUint16(8, true),
    index: view.getUint16(10, true),
    dataBytes: view.getUint32(12, true),
    animCrc: view.getUint32(16, true)
  };
}

export function animDeviceError(code) {
  const key = ANIM_ERROR_KEYS[code] ?? 'anim.error.unknown';
  const error = new Error(t('anim.deviceError', { error: t(key, { code }) }));
  error.deviceError = true;
  error.code = code;
  return error;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// transport.operation() wraps GATT failures and keeps the original as `cause`,
// so accept the wrapped and the raw shape of a missing characteristic/service.
const isMissing = error => error?.cause?.name === 'NotFoundError' || error?.name === 'NotFoundError' || /not\s*found/i.test(error?.message || '');

// Thrown when the device predates the animation service. The UI turns it into
// "animations unavailable" instead of a generic transfer error.
export class AnimUnavailableError extends Error {
  constructor(cause) {
    super(t('anim.unavailable'));
    this.name = 'AnimUnavailableError';
    this.unavailable = true;
    this.cause = cause;
  }
}

// The pages pattern: one transport.run('animation', ...) per session keeps the
// 5 s operation timeout, disconnect cancellation and diagnostics intact. All
// characteristic access goes through transport.operation().
export async function withAnim(transport, fn) {
  return transport.run('animation', async context => {
    const op = (label, action) => transport.operation(context, label, action);
    if (!transport.device?.gatt?.connected) throw new Error(t('anim.connectFirst'));
    // 7b1e0011..0013 live in their own service (7b1e0010), not in the editor's
    // 7b1e0001 service. A 16-bit alias rewrite only works inside one service.
    let service;
    try {
      service = await op('anim service', () => transport.device.gatt.getPrimaryService(ANIM_UUIDS.service));
    } catch (error) {
      // Old firmware has no animation service at all. That is a compatibility
      // gap, not a transport failure, so report it as such.
      if (isMissing(error)) throw new AnimUnavailableError(error);
      throw error;
    }
    const command = await op('anim command', () => service.getCharacteristic(ANIM_UUIDS.command));
    const status = await op('anim status', () => service.getCharacteristic(ANIM_UUIDS.status));
    const data = await op('anim data', () => service.getCharacteristic(ANIM_UUIDS.data));
    // The negotiated write ceiling comes from the editor service's capability
    // characteristic (7b1e0001); it only sizes DATA chunks, so its absence must
    // not block animations. Without it the conservative MTU-23 figure applies.
    let capabilities = null;
    try {
      const editor = await op('anim editor service', () => transport.device.gatt.getPrimaryService(UUIDS.service));
      const characteristic = await op('anim capabilities', () => editor.getCharacteristic(UUIDS.capabilities));
      capabilities = decodeCapabilities(await op('anim read capabilities', () => characteristic.readValue()));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const safeWrite = clamp(capabilities?.safeWrite ?? FALLBACK_SAFE_WRITE, 20, 244);

    async function request(bytes, expectedOp = bytes[0], deadlineMs = 30000) {
      await op(`anim write op ${bytes[0].toString(16)}`, () => command.writeValueWithResponse(bytes));
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        const value = await op('anim read status', () => status.readValue());
        const s = decodeAnimStatus(value);
        if (s.op !== expectedOp) throw new Error(t('anim.invalidStatus'));
        if (s.error) throw animDeviceError(s.error);
        if (!s.pending) return s;
        if (Date.now() > deadline) throw new Error(t('anim.timeout'));
        await pause(50);
      }
    }

    const info = () => request(packetInfo());
    // PLAY start 0xFFFF means "resume the last persisted position (or frame 0)".
    // The device answers with the index it actually used, which is what callers
    // must display; nothing may assume the request was honoured literally.
    const play = async (start = 0) => {
      const ack = await request(packetPlay(start));
      const resolved = ack.index;
      if (start !== PLAY_RESUME) {
        if (resolved !== start) throw new Error(t('anim.unexpectedAck', { label: 'PLAY', expected: start, got: resolved }));
      } else if (resolved === PLAY_RESUME || resolved >= ack.count) {
        // 0xFFFF must resolve to a real frame; 0xFFFF or an out-of-range index
        // means the device did not resume anything we can describe.
        throw new Error(t('anim.unexpectedAck', { label: 'PLAY', expected: t('anim.resumeAny'), got: resolved }));
      }
      if (!ack.playing) throw new Error(t('anim.unexpectedAck', { label: 'PLAY', expected: t('anim.playingFlag'), got: ack.flags }));
      return { ...ack, start: resolved, resumed: start === PLAY_RESUME };
    };
    const stop = () => request(packetStop());
    const remove = rev => request(packetDelete(rev));

    // READ returns `offset:u16` followed by up to 18 payload bytes; offset ==
    // blobLen yields only the 2-byte offset. status.dataBytes is the whole
    // stored blob length (8 + encLen) for the frame being read.
    async function readBlob(index, blobLen) {
      const blob = new Uint8Array(blobLen);
      let offset = 0;
      while (offset < blobLen) {
        const s = await request(packetRead(index, offset));
        if (s.dataBytes !== blobLen) throw new Error(t('anim.readLength', { expected: blobLen, got: s.dataBytes }));
        const value = await op('anim read data', () => data.readValue());
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        if (view.byteLength < 2 || view.getUint16(0, true) !== offset) throw new Error(t('anim.readOffset', { offset }));
        const chunk = new Uint8Array(value.buffer, value.byteOffset + 2, value.byteLength - 2);
        if (offset + chunk.length > blobLen) throw new Error(t('anim.readLength', { expected: blobLen, got: offset + chunk.length }));
        // A short-but-empty chunk would spin forever; treat it as a failure.
        if (!chunk.length) throw new Error(t('anim.readLength', { expected: blobLen, got: offset }));
        blob.set(chunk, offset);
        offset += chunk.length;
      }
      return blob;
    }

    // Verification decodes what it read and compares CRCs against the local
    // frames; a mismatch is reported, never papered over.
    async function verifyFrames(frames, blobLengths, progress) {
      const decoder = new FrameDecoder();
      for (let i = 0; i < frames.length; i++) {
        const blob = await readBlob(i, blobLengths[i]);
        const decoded = decoder.push(blob).bytes;
        const expected = frames[i] instanceof Uint8Array ? frames[i] : Uint8Array.from(frames[i]);
        if (crc32(decoded) !== crc32(expected)) throw new Error(t('anim.verifyMismatch', { index: i + 1 }));
        progress?.(i + 1, frames.length);
      }
    }

    async function send(frames, encoded, { start = 0, verify = false, loop = true, progress = () => {}, onPhase = () => {}, cancelled = () => false } = {}) {
      const blobs = encoded.blobs;
      if (!frames.length) throw new Error(t('anim.empty'));
      if (frames.length > GIF_MAX_FRAMES) throw new Error(t('anim.tooManyFrames', { count: frames.length, max: GIF_MAX_FRAMES }));
      const snapshot = await info();
      const rev = snapshot.revision;
      const crc = animationCrc(frames);
      const blobLengths = blobs.map(blob => blob.length);
      // Progress counts payload bytes on the wire; the stored blobs add the
      // 8-byte headers, which DATA never sends.
      const totalBytes = blobs.reduce((sum, blob) => sum + blob.length - FRAME_HEADER_BYTES, 0);
      let sentBytes = 0;
      let staged = false;
      try {
        onPhase('begin');
        // BEGIN flags: bit 0 = loop, every other bit must be zero.
        const begun = await request(packetBegin(rev, frames.length, loop ? 1 : 0, crc));
        if (begun.index !== 0) throw new Error(t('anim.unexpectedAck', { label: 'BEGIN', expected: 0, got: begun.index }));
        staged = true;
        for (let i = 0; i < frames.length; i++) {
          if (cancelled()) throw new Error(t('anim.cancelled'));
          const blob = blobs[i];
          onPhase('frame', i);
          // FRAME carries kind/encLen/crc, so DATA streams the payload only:
          // the 8-byte blob header is not retransmitted (offsets 0..encLen).
          const payload = blob.subarray(FRAME_HEADER_BYTES);
          const opened = await request(packetFrame(i, blob[0], encoded.encLens[i], encoded.crcs[i], encoded.delays[i]));
          if (opened.index !== i) throw new Error(t('anim.unexpectedAck', { label: 'FRAME', expected: i, got: opened.index }));
          const payloadMax = safeWrite - 3;
          for (let offset = 0; offset < payload.length;) {
            if (cancelled()) throw new Error(t('anim.cancelled'));
            const end = Math.min(offset + payloadMax, payload.length);
            const written = await request(packetData(offset, payload.subarray(offset, end)));
            sentBytes += end - offset;
            offset = end;
            if (written.index !== offset) throw new Error(t('anim.unexpectedAck', { label: 'DATA', expected: offset, got: written.index }));
            progress(sentBytes, totalBytes);
          }
          const sealed = await request(packetFrameCommit());
          const nextIndex = i + 1 < frames.length ? i + 1 : 0xffff;
          if (sealed.index !== nextIndex) throw new Error(t('anim.unexpectedAck', { label: 'FRAME_COMMIT', expected: nextIndex, got: sealed.index }));
        }
        if (cancelled()) throw new Error(t('anim.cancelled'));
        onPhase('commit');
        staged = false;
        const committed = await request(packetCommit());
        if (committed.revision !== rev + 1 || committed.count !== frames.length || committed.animCrc !== crc) throw new Error(t('anim.invalidCommit'));
        if (verify) { onPhase('verify'); await verifyFrames(frames, blobLengths, () => progress(totalBytes, totalBytes)); }
        let played = null;
        if (start !== null) { onPhase('play'); played = await play(start); }
        return {
          revision: committed.revision, count: committed.count, crc, safeWrite,
          bytes: totalBytes, storedBytes: blobLengths.reduce((sum, len) => sum + len, 0),
          start: played ? played.start : null, resumed: played ? played.resumed : false
        };
      } catch (error) {
        if (staged) {
          staged = false;
          // ABORT drops the staged transfer so the device keeps its previous
          // animation; a failed abort must not mask the original error.
          try { await request(packetAbort()); } catch { /* ignore */ }
        }
        throw error;
      }
    }

    return fn({ request, info, send, play, stop, remove, verifyFrames, safeWrite, capabilities });
  });
}

// ------------------------------------------------------------------------ UI

export function createAnimation({ transport, getSettings, useFrame } = {}) {
  const $ = id => document.getElementById(id);
  const ctx = $('anim-preview')?.getContext('2d');

  let source = null, sourceId = 0;
  let converted = [];
  let cache = { signature: null, blobs: [], crcs: [], delays: [], encLens: [] };
  let playing = false, timer = null, index = 0, resumeAfterHidden = false;
  let sending = false, cancelRequested = false, connected = false, lastSafeWrite = null, pollTimer = null;
  let statusKey = 'anim.status.idle', statusVars = {}, statusIsError = false;

  function setStatus(key, vars = {}, isError = false) {
    statusKey = key; statusVars = vars; statusIsError = isError;
    const node = $('anim-status');
    if (node) { node.textContent = t(key, vars); node.dataset.error = String(isError); }
  }

  const frameDelay = frame => effectiveDelay(frame, Number($('anim-min-delay')?.value) || GIF_MIN_DELAY_MS);

  // Re-converting every frame is the expensive step (64 × 30 500 px), so skip it
  // when neither the source nor the geometry/filter/throttle inputs changed.
  let conversionKey = null;

  function convert() {
    if (!source) {
      converted = [];
      conversionKey = null;
      cache = { signature: null, blobs: [], crcs: [], delays: [], encLens: [] };
      return;
    }
    const settings = getSettings?.() || {};
    const { geometry = {}, pack = {} } = settings;
    const keep = Number($('anim-keep')?.value) || 1;
    const minDelay = Number($('anim-min-delay')?.value) || GIF_MIN_DELAY_MS;
    const key = JSON.stringify({ id: sourceId, geometry, pack, keep, minDelay });
    if (key === conversionKey) return;
    const { frames } = throttleFrames(source.frames, keep);
    converted = frames.map(frame => ({
      bits: packBits(renderGray(frame.rgba, source.width, source.height, geometry), WIDTH, HEIGHT, pack),
      delayMs: frameDelay(frame),
      rawDelayMs: frame.rawDelayMs
    }));
    conversionKey = key;
    cache = { signature: null, blobs: [], crcs: [], delays: [], encLens: [] };
  }

  function encode() {
    if (!converted.length) return { blobs: [], crcs: [], delays: [], encLens: [] };
    const signature = JSON.stringify({ name: source?.name, delays: converted.map(f => f.delayMs), settings: getSettings?.() });
    if (cache.signature === signature && cache.blobs.length === converted.length) return cache;
    const blobs = [], crcs = [], delays = [], encLens = [];
    let previous = null;
    for (const frame of converted) {
      const encoded = encodeFrame(previous, frame.bits);
      blobs.push(encoded.blob);
      crcs.push(encoded.crc);
      delays.push(frame.delayMs);
      encLens.push(encoded.encLen);
      previous = frame.bits;
    }
    cache = { signature, blobs, crcs, delays, encLens };
    return cache;
  }

  function stats() {
    return estimateStats(encode().blobs.map(blob => blob.length), {
      safeWrite: lastSafeWrite ?? FALLBACK_SAFE_WRITE,
      verify: !!$('anim-verify')?.checked
    });
  }

  function draw(at = index) {
    if (!ctx) return;
    const image = ctx.createImageData(WIDTH, HEIGHT);
    const bits = converted[at]?.bits;
    const pixels = bits ? unpackBits(bits) : new Uint8Array(WIDTH * HEIGHT).fill(255);
    for (let i = 0; i < pixels.length; i++) {
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = pixels[i];
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const counter = $('anim-counter');
    if (counter) counter.textContent = converted.length ? t('anim.counter', { index: at + 1, total: converted.length }) : t('anim.counterEmpty');
  }

  function refresh() {
    convert();
    const count = converted.length;
    const name = $('anim-name');
    if (name) name.textContent = source ? source.name : t('anim.noneSelected');
    // A standing error (import failure, transfer failure) stays until something
    // explicitly replaces it, so re-rendering never hides what went wrong.
    if (!statusIsError) {
      if (source && count > GIF_MAX_FRAMES) setStatus('anim.tooManyFrames', { count, max: GIF_MAX_FRAMES }, true);
      else if (source) setStatus('anim.loaded', { name: source.name, count });
    }
    const info = count ? stats() : null;
    const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    set('anim-frame-count', count ? String(count) : '—');
    set('anim-encoded-bytes', info ? formatBytes(info.encodedBytes) : '—');
    set('anim-ratio', info && info.encodedBytes ? `${info.ratio.toFixed(2)}×` : '—');
    set('anim-ble-time', info ? formatDuration(info.timeMs) : '—');
    const assumption = $('anim-assumption');
    if (assumption && info) {
      assumption.textContent = t('anim.bleAssumption', {
        safeWrite: info.safeWrite,
        payload: info.payloadMax,
        perOp: info.perOperationMs,
        ops: info.ops,
        source: lastSafeWrite ? t('anim.bleNegotiated') : t('anim.bleFallback')
      });
    }
    const warnings = [];
    if (source) {
      const zero = source.frames.filter(frame => frame.rawDelayMs === 0).length;
      if (zero) warnings.push(t('anim.warn.zeroDelay', { count: zero, floor: GIF_FLOOR_DELAY_MS }));
      const fast = source.frames.filter(frame => frame.rawDelayMs > 0 && frame.rawDelayMs < GIF_FLOOR_DELAY_MS).length;
      if (fast) warnings.push(t('anim.warn.fastFrames', { count: fast, floor: GIF_FLOOR_DELAY_MS }));
      if (source.frames.length > GIF_MAX_FRAMES) warnings.push(t('anim.warn.frameLimit', { count: source.frames.length, max: GIF_MAX_FRAMES }));
      if (source.loopCount !== null) {
        // The NETSCAPE extension stores 0 as "loop forever".
        warnings.push(source.loopCount === 0
          ? t('anim.warn.loopForever')
          : t('anim.warn.loopHint', { loops: source.loopCount }));
      }
    }
    const warning = $('anim-warning');
    if (warning) { warning.textContent = warnings.join(' '); warning.hidden = !warnings.length; }
    if (index >= count) index = 0;
    draw(index);
    updateButtons();
  }

  function updateButtons() {
    const has = converted.length > 0;
    const over = converted.length > GIF_MAX_FRAMES;
    const set = (id, disabled) => { const node = $(id); if (node) node.disabled = disabled; };
    set('anim-play', !has || playing);
    set('anim-pause', !playing);
    set('anim-stop', !has);
    set('anim-send', !has || sending || over || !connected);
    set('anim-send-play', !has || sending || over || !connected);
    set('anim-device-play', !has || sending || !connected || over);
    set('anim-device-resume', sending || !connected || over);
    set('anim-device-stop', sending || !connected);
    set('anim-device-delete', sending || !connected);
    set('anim-cancel', !sending);
    set('anim-use-frame', !has);
  }

  function stopPlayback(update = true) {
    playing = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (update) updateButtons();
  }

  function step() {
    if (!playing || !converted.length) return;
    index = (index + 1) % converted.length;
    if (index === 0 && $('anim-loop') && !$('anim-loop').checked) {
      draw(0);
      playing = false;
      updateButtons();
      return;
    }
    draw(index);
    timer = setTimeout(step, converted[index].delayMs);
  }

  function playPreview() {
    if (!converted.length || playing) return;
    playing = true;
    draw(index);
    timer = setTimeout(step, converted[index].delayMs);
    updateButtons();
  }

  async function importFile(file) {
    try {
      // Decode fully before touching any state: a rejected file must leave the
      // previously loaded animation and the editor exactly as they were.
      const gif = decodeGif(new Uint8Array(await file.arrayBuffer()), { maxFrames: UI_IMPORT_MAX_FRAMES });
      sourceId += 1;
      source = { name: file.name, width: gif.width, height: gif.height, loopCount: gif.loopCount, frames: gif.frames };
      index = 0;
      statusIsError = false;
      stopPlayback(false);
      refresh();
      return gif;
    } catch (error) {
      if (error instanceof GifError && error.code === 'frame-limit') {
        setStatus('anim.importTooMany', { count: error.count, max: error.max, limit: GIF_MAX_FRAMES }, true);
      } else setStatus('anim.importError', { error: error.message }, true);
      throw error;
    }
  }

  // ------------------------------------------------------------- device I/O

  function setProgress(done, total) {
    const progress = $('anim-progress');
    if (!progress) return;
    progress.max = Math.max(1, total);
    progress.value = Math.min(progress.max, done);
  }

  async function sendToDevice({ play = false } = {}) {
    if (sending) return;
    if (!transport.device?.gatt?.connected) { setStatus('anim.connectFirst', {}, true); return; }
    sending = true; cancelRequested = false;
    stopPlayback();
    updateButtons();
    const progressNode = $('anim-progress');
    if (progressNode) progressNode.value = 0;
    try {
      if (!converted.length) throw new Error(t('anim.empty'));
      if (converted.length > GIF_MAX_FRAMES) throw new Error(t('anim.tooManyFrames', { count: converted.length, max: GIF_MAX_FRAMES }));
      const encoded = encode();
      const frames = converted.map(frame => frame.bits);
      const info = stats();
      setStatus('anim.sending', { count: info.count, bytes: formatBytes(info.encodedBytes) });
      const state = await withAnim(transport, wire => {
        lastSafeWrite = wire.safeWrite;
        return wire.send(frames, encoded, {
          start: play ? 0 : null,
          verify: !!$('anim-verify')?.checked,
          loop: !!$('anim-loop')?.checked,
          cancelled: () => cancelRequested,
          onPhase: phase => {
            if (phase === 'verify') setStatus('anim.verifying', { count: info.count });
            else if (phase === 'commit') setStatus('anim.committing');
            else if (phase === 'begin') setStatus('anim.beginning', { count: info.count });
          },
          progress: (sent, total) => {
            setProgress(sent, total);
            setStatus('anim.sendingProgress', { count: info.count, sent: formatBytes(sent), total: formatBytes(total) });
          }
        });
      });
      setProgress(state.bytes, state.bytes);
      // "Send and play" always asks for frame 0; report the index the device
      // acknowledged rather than assuming the request was honoured verbatim.
      setStatus(play ? 'anim.sentPlaying' : 'anim.sent', { count: state.count, index: state.start === null ? 0 : state.start + 1 });
      await pollInfo();
    } catch (error) {
      if (cancelRequested) setStatus('anim.cancelled');
      else if (error.unavailable) setStatus('anim.unavailable', {}, true);
      else setStatus('anim.sendFailed', { error: error.message }, true);
      if (!transport.device?.gatt?.connected) setConnected(false);
    } finally {
      sending = false; cancelRequested = false;
      updateButtons();
    }
  }

  async function pollInfo() {
    if (!transport.device?.gatt?.connected) { setConnected(false); return null; }
    if (transport.active) return null;
    try {
      const info = await withAnim(transport, wire => wire.info());
      const node = $('anim-device-state');
      // INFO index is 0xFFFF when not playing, so never add 1 blindly.
      const position = info.playing && info.index < info.count ? info.index + 1 : null;
      if (node) {
        node.textContent = !info.count ? t('anim.stateEmpty')
          : position !== null ? t('anim.statePlaying', { index: position, count: info.count })
            : t('anim.stateReady', { count: info.count });
      }
      return info;
    } catch (error) {
      const node = $('anim-device-state');
      if (node) node.textContent = t(error.unavailable ? 'anim.unavailableShort' : 'anim.stateUnknown');
      return null;
    }
  }

  function setConnected(value) {
    connected = !!value;
    if (connected) {
      if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden && !sending) pollInfo(); }, 1500);
      pollInfo();
    } else {
      lastSafeWrite = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      const node = $('anim-device-state');
      if (node) node.textContent = t('anim.stateUnknown');
    }
    updateButtons();
    refresh();
  }

  // ------------------------------------------------------------------ wiring

  // The panel reuses the single existing file input; app.js routes GIFs here.
  $('anim-open')?.addEventListener('click', () => $('file')?.click());
  $('anim-play')?.addEventListener('click', playPreview);
  $('anim-pause')?.addEventListener('click', () => { stopPlayback(); draw(index); });
  $('anim-stop')?.addEventListener('click', () => { stopPlayback(); index = 0; draw(0); });
  for (const id of ['anim-keep', 'anim-min-delay', 'anim-verify', 'anim-loop']) {
    $(id)?.addEventListener('input', () => { stopPlayback(); refresh(); });
    $(id)?.addEventListener('change', () => { stopPlayback(); refresh(); });
  }
  $('anim-send')?.addEventListener('click', () => sendToDevice({ play: false }));
  $('anim-send-play')?.addEventListener('click', () => sendToDevice({ play: true }));
  $('anim-cancel')?.addEventListener('click', () => { cancelRequested = true; setStatus('anim.cancelling'); });
  $('anim-refresh-device')?.addEventListener('click', () => pollInfo());
  $('anim-device-play')?.addEventListener('click', async () => {
    if (sending) return;
    sending = true; updateButtons();
    try {
      const played = await withAnim(transport, wire => wire.play(0));
      setStatus('anim.devicePlayingAt', { index: played.start + 1 });
      await pollInfo();
    } catch (error) { setStatus(error.unavailable ? 'anim.unavailable' : 'anim.sendFailed', error.unavailable ? {} : { error: error.message }, true); }
    finally { sending = false; updateButtons(); }
  });
  $('anim-device-resume')?.addEventListener('click', async () => {
    if (sending) return;
    sending = true; updateButtons();
    try {
      const played = await withAnim(transport, wire => wire.play(PLAY_RESUME));
      setStatus('anim.resumedAt', { index: played.start + 1 });
      await pollInfo();
    } catch (error) { setStatus(error.unavailable ? 'anim.unavailable' : 'anim.sendFailed', error.unavailable ? {} : { error: error.message }, true); }
    finally { sending = false; updateButtons(); }
  });
  $('anim-device-stop')?.addEventListener('click', async () => {
    if (sending) return;
    sending = true; updateButtons();
    try {
      await withAnim(transport, wire => wire.stop());
      // STOP also restores static content on the device: the first stored page,
      // or a cleared panel when no pages exist. It does not freeze a frame.
      setStatus('anim.deviceStoppedRestored');
      await pollInfo();
    }
    catch (error) { setStatus(error.unavailable ? 'anim.unavailable' : 'anim.sendFailed', error.unavailable ? {} : { error: error.message }, true); }
    finally { sending = false; updateButtons(); }
  });
  $('anim-device-delete')?.addEventListener('click', async () => {
    if (sending) return;
    if (!confirm(t('anim.deleteConfirm'))) return;
    sending = true; updateButtons();
    try {
      const revision = await withAnim(transport, async wire => (await wire.remove((await wire.info()).revision)).revision);
      setStatus('anim.deleted', { revision });
      await pollInfo();
    } catch (error) { setStatus(error.unavailable ? 'anim.unavailable' : 'anim.sendFailed', error.unavailable ? {} : { error: error.message }, true); }
    finally { sending = false; updateButtons(); }
  });
  $('anim-use-frame')?.addEventListener('click', () => {
    if (!converted.length || !useFrame) return;
    stopPlayback();
    useFrame({ bits: converted[index].bits, index, name: source?.name });
  });
  // Any editing mode or static send takes the screen over; playback must stop.
  for (const id of ['mode-image', 'mode-text', 'mode-draw', 'send']) $(id)?.addEventListener('click', () => stopPlayback());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resumeAfterHidden = playing; stopPlayback(); }
    else if (resumeAfterHidden) { resumeAfterHidden = false; playPreview(); }
  });

  subscribeLanguage(() => { if (statusKey) setStatus(statusKey, statusVars, statusIsError); refresh(); });
  refresh();

  return {
    importFile,
    refresh,
    stopPlayback,
    stats,
    setConnected,
    get frames() { return converted.map(frame => frame.bits); },
    get source() { return source; },
    isGif,
    withAnim: fn => withAnim(transport, fn)
  };
}
