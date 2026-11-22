import { FRAME_BYTES, crc32 } from './image.js';
import { t } from './i18n.js';
export const UUIDS = Object.freeze({ service: '7b1e0001-6ba2-4f25-8ac7-1d54e91a1000', command: '7b1e0002-6ba2-4f25-8ac7-1d54e91a1000', status: '7b1e0003-6ba2-4f25-8ac7-1d54e91a1000', command2: '7b1e0004-6ba2-4f25-8ac7-1d54e91a1000', status2: '7b1e0005-6ba2-4f25-8ac7-1d54e91a1000', capabilities: '7b1e0006-6ba2-4f25-8ac7-1d54e91a1000' });
const packet = (opcode, id, length) => { const b = new Uint8Array(length); const v = new DataView(b.buffer); b[0] = opcode; v.setUint32(1, id, true); return [b, v]; };
export function packetStart(id, crc) { const [b, v] = packet(1, id, 11); v.setUint16(5, FRAME_BYTES, true); v.setUint32(7, crc, true); return b; }
export function packetData(id, offset, bytes) { if (bytes.length < 1 || bytes.length > 13 || offset < 0 || offset + bytes.length > FRAME_BYTES) throw new Error(t('ble.invalidDataPacket')); const [b, v] = packet(2, id, 7 + bytes.length); v.setUint16(5, offset, true); b.set(bytes, 7); return b; }
export function packetCommit(id) { return packet(3, id, 5)[0]; }
export function packetAbort(id) { return packet(4, id, 5)[0]; }
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
export function chooseCodec(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== FRAME_BYTES) throw new Error(t('ble.invalidFrameLength'));
  const encoded = encodePackBits(raw);
  return encoded.length < FRAME_BYTES ? { codec: 1, bytes: encoded } : { codec: 0, bytes: raw };
}
export function packetStart2(id, codec, decodedLen, encodedLen, crc) {
  if (![0, 1].includes(codec) || decodedLen !== FRAME_BYTES || encodedLen < 1 || encodedLen > FRAME_BYTES || (codec === 0 && encodedLen !== FRAME_BYTES)) throw new Error(t('ble.invalidStart2'));
  const [b, v] = packet(0x11, id, 14);
  b[5] = codec; v.setUint16(6, decodedLen, true); v.setUint16(8, encodedLen, true); v.setUint32(10, crc, true); return b;
}
export function packetData2(id, offset, bytes, ceiling) {
  if (!Number.isInteger(ceiling) || ceiling < 20 || ceiling > 244 || !Number.isInteger(offset) || offset < 0 || !bytes.length || bytes.length > ceiling - 7 || offset + bytes.length > FRAME_BYTES) throw new Error(t('ble.invalidData2'));
  const [b, v] = packet(0x12, id, 7 + bytes.length); v.setUint16(5, offset, true); b.set(bytes, 7); return b;
}
export function decodeCapabilities(bytes) {
  const v = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength !== 20 || v.getUint32(0, true) !== 0x324c4245 || v.getUint8(4) !== 2 || v.getUint8(5) !== 0 || v.getUint8(6) !== 3 || v.getUint8(7) !== 1 || v.getUint16(8, true) < 20 || v.getUint16(8, true) > 244 || v.getUint16(10, true) !== FRAME_BYTES || v.getUint16(12, true) !== FRAME_BYTES || v.getUint16(14, true) !== 15000 || v.getUint32(16, true) !== 0) throw new Error(t('ble.invalidCapabilities'));
  return { major: 2, minor: 0, codecMask: 3, flags: 1, safeWrite: v.getUint16(8, true), decodedMax: FRAME_BYTES, encodedMax: FRAME_BYTES, idleTimeoutMs: 15000 };
}
function decodeStatus2(bytes) {
  const v = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength !== 20 || v.getUint8(0) !== 2 || v.getUint8(3) > 1) throw new Error(t('ble.invalidStatus2'));
  return { version: 2, state: v.getUint8(1), error: v.getUint8(2), codec: v.getUint8(3), id: v.getUint32(4, true), received: v.getUint16(8, true), total: v.getUint16(10, true), expectedCRC: v.getUint32(12, true), generation: v.getUint32(16, true) };
}
export function decodeStatus(bytes) {
  const v = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength !== 20 || v.getUint8(0) !== 1 || v.getUint8(3) !== 0) throw new Error(t('ble.invalidStatus'));
  return { version: v.getUint8(0), state: v.getUint8(1), error: v.getUint8(2), id: v.getUint32(4, true), received: v.getUint16(8, true), total: v.getUint16(10, true), expectedCRC: v.getUint32(12, true), generation: v.getUint32(16, true) };
}
const remoteErrorKeys = [null, 'ble.remote.malformed', 'ble.remote.busy', 'ble.remote.transferId', 'ble.remote.offset', 'ble.remote.length', 'ble.remote.crc', 'ble.remote.padding', 'ble.remote.timeout', 'ble.remote.disconnected'];
const remoteError = code => code === 10 ? t('ble.remote.codec') : remoteErrorKeys[code] ? t(remoteErrorKeys[code]) : t('ble.remote.unknown', { code });
function localizedLabel(label) {
  if (label === 'START') return t('ble.command.start');
  if (label === 'START2') return t('ble.command.start2');
  if (label === 'COMMIT') return t('ble.command.commit');
  if (label === 'COMMIT2') return t('ble.command.commit2');
  const match = /^DATA(2)? offset (\d+)$/.exec(label);
  return match ? t(match[1] ? 'ble.command.data2Offset' : 'ble.command.dataOffset', { offset: match[2] }) : label;
}
function localizedStage(stage) {
  if (stage === 'connect') return t('ble.stage.connect');
  const fixed = { 'discovery service': 'discoveryService', 'discovery command': 'discoveryCommand', 'discovery status': 'discoveryStatus', 'discovery capabilities': 'discoveryCapabilities', 'discovery command2': 'discoveryCommand2', 'discovery status2': 'discoveryStatus2', 'read capabilities': 'readCapabilities', 'read status': 'readStatus', 'refresh read status': 'refreshReadStatus' };
  if (fixed[stage]) return t(`ble.stage.${fixed[stage]}`);
  let match = /^(write|read ack) (.+)$/.exec(stage);
  if (match) return t(match[1] === 'write' ? 'ble.stage.write' : 'ble.stage.readAck', { label: localizedLabel(match[2]) });
  match = /^(DATA2? offset \d+)$/.exec(stage);
  return match ? localizedLabel(match[1]) : stage;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class BleTransport {
  // Inject bluetooth or preconnected command/status characteristics for tests.
  constructor({ bluetooth = globalThis.navigator?.bluetooth, device = null, command = null, status = null, command2 = null, status2 = null, capabilities = null, force20 = false, onProgress = () => {}, onStatus = () => {}, onDiagnostic = () => {}, timeout = 5000, refreshTimeout = 45000 } = {}) {
    Object.assign(this, { bluetooth, device, command, status, command2, status2, capabilities, force20, onProgress, onStatus, onDiagnostic, timeout, refreshTimeout });
    this.busy = false;
    this.active = null;
    this.pendingOperations = new Map();
    this.listener = null;
  }
  diagnostic(stage, event, error) {
    try { this.onDiagnostic({ stage, event, ...(error ? { error } : {}) }); } catch {} // Diagnostics must not change transport behavior.
  }
  disconnect() {
    const active = this.active;
    if (active && !active.cancelled) {
      active.cancelled = true;
      active.cancel(t('ble.disconnected'));
    }
    if (this.listener) {
      this.listener.device.removeEventListener?.('gattserverdisconnected', this.listener.fn);
      this.listener = null;
    }
    this.command = null; this.status = null; this.command2 = null; this.status2 = null; this.capabilities = null;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
  async run(name, fn) {
    if (this.active) {
      const name = this.active.name === 'read status' ? t('ble.operationName.readStatus') : t(`ble.operationName.${this.active.name}`);
      throw new Error(t('ble.operationInProgress', { operation: name }));
    }
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = reject; });
    // A cancellation can occur between operations, when no race is listening.
    cancelled.catch(() => {});
    const context = { name, cancel, cancelled: false, cancellation: cancelled };
    this.active = context;
    if (name === 'send') this.busy = true;
    try { return await fn(context); }
    catch (error) { console.error('Bluetooth error:', error); throw error; }
    finally { if (this.active === context) this.active = null; if (name === 'send') this.busy = false; }
  }
  async operation(context, stage, action) {
    let timer;
    try {
      if (context.cancelled) throw new Error(t('ble.disconnected'));
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (context.cancelled) throw new Error(t('ble.disconnected'));
          const device = this.device;
          const pending = Promise.resolve().then(() => { if (context.cancelled) throw new Error(t('ble.disconnected')); return action(); });
          if (device) {
            let operations = this.pendingOperations.get(device);
            if (!operations) this.pendingOperations.set(device, operations = new Set());
            operations.add(pending);
            const clear = () => { operations.delete(pending); if (!operations.size) this.pendingOperations.delete(device); };
            pending.then(clear, clear);
          }
          return pending;
        }), context.cancellation,
        new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(t('ble.timeout')); e.timeout = true; reject(e); }, this.timeout); })
      ]);
      if (context.cancelled) throw new Error(t('ble.disconnected'));
      return result;
    } catch (cause) {
      if (cause.timeout) this.disconnect();
      const error = new Error(t('ble.operationFailed', { stage: localizedStage(stage), error: cause.message || cause }), { cause });
      error.timeout = !!cause.timeout;
      this.diagnostic(stage, 'error', error);
      throw error;
    } finally { clearTimeout(timer); }
  }
  connect() { return this.run('connect', async context => {
    if (!this.bluetooth) throw new Error(t('ble.bluetoothUnavailable'));
    // The chooser is user-controlled and deliberately has no GATT timeout.
    let device;
    try { device = await Promise.race([this.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] }), context.cancellation]); }
    catch (cause) { throw new Error(t('ble.requestDeviceFailed', { error: cause.message || cause }), { cause }); }
    if (context.cancelled) throw new Error(t('ble.requestDeviceDisconnected'));
    if (this.pendingOperations.get(device)?.size) throw new Error(t('ble.pendingOperation'));
    this.disconnectExisting();
    this.device = device;
    const server = await this.operation(context, 'connect', () => {
      const pending = Promise.resolve().then(() => device.gatt.connect());
      pending.then(() => { if (context.cancelled && device.gatt.connected) device.gatt.disconnect(); }, () => {});
      return pending;
    });
    const service = await this.operation(context, 'discovery service', () => server.getPrimaryService(UUIDS.service));
    const command = await this.operation(context, 'discovery command', () => service.getCharacteristic(UUIDS.command));
    const status = await this.operation(context, 'discovery status', () => service.getCharacteristic(UUIDS.status));
    this.command = command; this.status = status;
    const fn = () => {
      if (this.device !== device || this.listener?.fn !== fn) return;
      this.disconnect();
      this.onStatus({ disconnected: true });
    };
    this.listener = { device, fn };
    device.addEventListener?.('gattserverdisconnected', fn);
    try {
      let capabilities, missing = false;
      try { capabilities = await this.operation(context, 'discovery capabilities', () => service.getCharacteristic(UUIDS.capabilities)); }
      catch (error) { if (error.cause?.name !== 'NotFoundError') throw error; missing = true; }
      if (!missing) {
        if (!capabilities) throw new Error(t('ble.invalidCharacteristic'));
        const command2 = await this.operation(context, 'discovery command2', () => service.getCharacteristic(UUIDS.command2));
        const status2 = await this.operation(context, 'discovery status2', () => service.getCharacteristic(UUIDS.status2));
        const value = await this.operation(context, 'read capabilities', () => capabilities.readValue());
        decodeCapabilities(value);
        this.capabilities = capabilities; this.command2 = command2; this.status2 = status2;
      }
    } catch (error) { this.disconnect(); throw error; }
    return this.capabilities ? this.readStatus2Internal(context, 'read status') : this.readStatusInternal(context, 'read status');
  }); }
  disconnectExisting() {
    if (this.listener) this.listener.device.removeEventListener?.('gattserverdisconnected', this.listener.fn);
    this.listener = null;
    this.command = null; this.status = null; this.command2 = null; this.status2 = null; this.capabilities = null;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
  readStatus() { return this.run('read status', context => this.capabilities ? this.readStatus2Internal(context, 'read status') : this.readStatusInternal(context, 'read status')); }
  async readStatusInternal(context, stage) {
    if (!this.status) throw new Error(t('ble.notConnected', { stage: localizedStage(stage) }));
    const value = await this.operation(context, stage, () => this.status.readValue());
    let s;
    try { s = decodeStatus(value); } catch (cause) { throw new Error(t('ble.operationFailed', { stage: localizedStage(stage), error: cause.message }), { cause }); }
    this.onStatus(s); return s;
  }
  writeWithResponse(characteristic, bytes, requireProperties = false) {
    const properties = characteristic.properties;
    if ((requireProperties || properties) && !properties?.write) throw new Error(t('ble.writeRequired'));
    if (typeof characteristic.writeValueWithResponse === 'function') return characteristic.writeValueWithResponse(bytes);
    if (properties?.write && !properties.writeWithoutResponse && typeof characteristic.writeValue === 'function') return characteristic.writeValue(bytes);
    throw new Error(t('ble.writeUnavailable'));
  }
  async readStatus2Internal(context, stage) {
    if (!this.status2) throw new Error(t('ble.notConnected', { stage: localizedStage(stage) }));
    const value = await this.operation(context, stage, () => this.status2.readValue());
    let s;
    try { s = decodeStatus2(value); } catch (cause) { throw new Error(t('ble.operationFailed', { stage: localizedStage(stage), error: cause.message }), { cause }); }
    this.onStatus(s); return s;
  }
  async send2(context, frame, id, crc) {
    if (!this.command2 || !this.status2 || !this.capabilities) throw new Error(t('ble.incompleteV2'));
    let caps;
    try { caps = decodeCapabilities(await this.operation(context, 'read capabilities', () => this.capabilities.readValue())); }
    catch (error) { this.disconnect(); throw error; }
    const ceiling = this.force20 ? 20 : caps.safeWrite;
    const { codec, bytes } = chooseCodec(frame);
    try { this.onDiagnostic({ stage: 'transfer', event: 'info', codec: codec === 0 ? 'raw' : 'PackBits', rawBytes: frame.length, wireBytes: bytes.length, serverCeiling: caps.safeWrite, writeCeiling: ceiling }); } catch {}
    const check = (s, states, received) => {
      if (s.error) { const error = new Error(t('ble.deviceError', { error: remoteError(s.error) })); error.deviceError = true; throw error; }
      if (s.id !== id || s.codec !== codec || s.total !== bytes.length || s.expectedCRC !== crc || s.received !== received || !states.includes(s.state)) throw new Error(t('ble.unexpectedAck'));
      return s;
    };
    const ack = async (data, label, states, received) => {
      try {
        await this.operation(context, `write ${label}`, () => this.writeWithResponse(this.command2, data, true));
        return check(await this.readStatus2Internal(context, `read ack ${label}`), states, received);
      } catch (cause) {
        this.disconnect();
        throw new Error(t('ble.ackRetry', { label: localizedLabel(label), error: cause.message }), { cause });
      }
    };
    let s = await ack(packetStart2(id, codec, FRAME_BYTES, bytes.length, crc), 'START2', [1], 0);
    let offset = 0;
    this.onProgress(offset, bytes.length);
    while (offset < bytes.length) {
      const end = Math.min(offset + ceiling - 7, bytes.length);
      s = await ack(packetData2(id, offset, bytes.subarray(offset, end), ceiling), `DATA2 offset ${offset}`, [1], end);
      offset = end; this.onProgress(offset, bytes.length);
    }
    s = await ack(packet(0x13, id, 5)[0], 'COMMIT2', [2, 3, 4], bytes.length);
    const deadline = Date.now() + this.refreshTimeout;
    try {
      while (s.state !== 4) {
        if (Date.now() >= deadline) throw new Error(t('ble.refreshTimeout'));
        await Promise.race([sleep(300), context.cancellation]);
        s = check(await this.readStatus2Internal(context, 'refresh read status'), [2, 3, 4], bytes.length);
      }
      return s;
    } catch (error) { this.disconnect(); throw error; }
  }
  async writeAck(context, bytes, label, accept) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (context.cancelled || !this.command || !this.status) throw new Error(t('ble.disconnected'));
      try {
        await this.operation(context, `write ${label}`, () => this.writeWithResponse(this.command, bytes));
        const s = await this.readStatusInternal(context, `read ack ${label}`);
        if (s.error) { const error = new Error(t('ble.operationFailed', { stage: localizedStage(`read ack ${label}`), error: t('ble.deviceError', { error: remoteError(s.error) }) })); error.deviceError = true; throw error; }
        if (accept(s)) return s;
        last = new Error(t('ble.operationFailed', { stage: localizedStage(`read ack ${label}`), error: t('ble.unexpectedAck') }));
      } catch (e) {
        if (context.cancelled || !this.command || e.timeout || e.deviceError) throw e;
        last = e;
      }
    }
    throw last;
  }
  send(frame, id = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) { return this.run('send', async context => {
    if (!(frame instanceof Uint8Array) || frame.length !== FRAME_BYTES) throw new Error(t('ble.invalidFrameLength'));
    for (let y = 0; y < 250; y++) if (frame[y * 16 + 15] & 63) throw new Error(t('ble.invalidFramePadding'));
    const crc = crc32(frame);
    if (this.capabilities || this.command2 || this.status2) return this.send2(context, frame, id, crc);
    let s = await this.writeAck(context, packetStart(id, crc), 'START', s => s.id === id && s.state === 1 && s.total === FRAME_BYTES && s.expectedCRC === crc && s.received <= FRAME_BYTES);
    let offset = s.received;
    this.onProgress(offset, FRAME_BYTES);
    while (offset < FRAME_BYTES) {
      const end = Math.min(offset + 13, FRAME_BYTES);
      s = await this.writeAck(context, packetData(id, offset, frame.subarray(offset, end)), `DATA offset ${offset}`, s => s.id === id && s.state === 1 && s.received === end);
      offset = end; this.onProgress(offset, FRAME_BYTES);
    }
    s = await this.writeAck(context, packetCommit(id), 'COMMIT', s => s.id === id && [2, 3, 4].includes(s.state));
    const deadline = Date.now() + this.refreshTimeout;
    while (s.state !== 4) {
      if (Date.now() >= deadline) throw new Error(t('ble.refreshTimeout'));
      await Promise.race([sleep(300), context.cancellation]);
      s = await this.readStatusInternal(context, 'refresh read status');
      if (s.id !== id || s.error || s.state === 5) throw new Error(t('ble.refreshFailed', { error: s.error ? remoteError(s.error) : t('ble.remote.unknown', { code: 'unexpected status' }) }));
      if (![2, 3, 4].includes(s.state)) throw new Error(t('ble.unexpectedDisplayStatus'));
    }
    return s;
  }); }
}
