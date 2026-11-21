import { FRAME_BYTES, crc32 } from './image.js';
export const UUIDS = Object.freeze({ service: '7b1e0001-6ba2-4f25-8ac7-1d54e91a1000', command: '7b1e0002-6ba2-4f25-8ac7-1d54e91a1000', status: '7b1e0003-6ba2-4f25-8ac7-1d54e91a1000' });
const packet = (opcode, id, length) => { const b = new Uint8Array(length); const v = new DataView(b.buffer); b[0] = opcode; v.setUint32(1, id, true); return [b, v]; };
export function packetStart(id, crc) { const [b, v] = packet(1, id, 11); v.setUint16(5, FRAME_BYTES, true); v.setUint32(7, crc, true); return b; }
export function packetData(id, offset, bytes) { if (bytes.length < 1 || bytes.length > 13 || offset < 0 || offset + bytes.length > FRAME_BYTES) throw new Error('Invalid data packet'); const [b, v] = packet(2, id, 7 + bytes.length); v.setUint16(5, offset, true); b.set(bytes, 7); return b; }
export function packetCommit(id) { return packet(3, id, 5)[0]; }
export function packetAbort(id) { return packet(4, id, 5)[0]; }
export function decodeStatus(bytes) {
  const v = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength !== 20 || v.getUint8(0) !== 1 || v.getUint8(3) !== 0) throw new Error('Invalid device status');
  return { version: v.getUint8(0), state: v.getUint8(1), error: v.getUint8(2), id: v.getUint32(4, true), received: v.getUint16(8, true), total: v.getUint16(10, true), expectedCRC: v.getUint32(12, true), generation: v.getUint32(16, true) };
}
const errors = ['none', 'malformed packet', 'device busy', 'transfer ID', 'offset', 'length', 'CRC mismatch', 'invalid padding', 'transfer timeout', 'disconnected'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class BleTransport {
  // Inject bluetooth or preconnected command/status characteristics for tests.
  constructor({ bluetooth = globalThis.navigator?.bluetooth, device = null, command = null, status = null, onProgress = () => {}, onStatus = () => {}, timeout = 5000, refreshTimeout = 45000 } = {}) {
    Object.assign(this, { bluetooth, device, command, status, onProgress, onStatus, timeout, refreshTimeout });
    this.busy = false;
  }
  disconnect() { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); this.command = null; this.status = null; }
  async operation(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bluetooth operation timed out; reconnect and restart the transfer')), this.timeout); })]); }
    catch (e) { if (String(e.message).includes('timed out')) this.disconnect(); throw e; }
    finally { clearTimeout(timer); }
  }
  async connect() {
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser. Use supported Chromium on HTTPS or localhost; iOS Safari is not supported.');
    this.device = await this.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] });
    const server = await this.operation(this.device.gatt.connect());
    const service = await this.operation(server.getPrimaryService(UUIDS.service));
    this.command = await this.operation(service.getCharacteristic(UUIDS.command));
    this.status = await this.operation(service.getCharacteristic(UUIDS.status));
    this.device.addEventListener?.('gattserverdisconnected', () => { this.command = null; this.status = null; this.onStatus({ disconnected: true }); });
    return this.readStatus();
  }
  async readStatus() { if (!this.status) throw new Error('Not connected'); const s = decodeStatus(await this.operation(this.status.readValue())); this.onStatus(s); return s; }
  async writeAck(bytes, accept) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.command || !this.status) throw new Error('Disconnected; reconnect and restart the transfer');
      try {
        await this.operation(this.command.writeValueWithResponse(bytes));
        const s = await this.readStatus();
        if (s.error) throw new Error(`Device error: ${errors[s.error] || s.error}`);
        if (accept(s)) return s;
        last = new Error('Unexpected device acknowledgement');
      } catch (e) {
        if (!this.command || /timed out|Device error/.test(e.message)) throw e;
        last = e;
      }
    }
    throw last;
  }
  async send(frame, id = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
    if (this.busy) throw new Error('Transfer already in progress');
    if (!(frame instanceof Uint8Array) || frame.length !== FRAME_BYTES) throw new Error('Invalid frame length');
    for (let y = 0; y < 250; y++) if (frame[y * 16 + 15] & 63) throw new Error('Invalid frame padding');
    this.busy = true;
    try {
      const crc = crc32(frame);
      let s = await this.writeAck(packetStart(id, crc), s => s.id === id && s.state === 1 && s.total === FRAME_BYTES && s.expectedCRC === crc && s.received <= FRAME_BYTES);
      let offset = s.received;
      this.onProgress(offset, FRAME_BYTES);
      while (offset < FRAME_BYTES) {
        const end = Math.min(offset + 13, FRAME_BYTES);
        s = await this.writeAck(packetData(id, offset, frame.subarray(offset, end)), s => s.id === id && s.state === 1 && s.received === end);
        offset = end; this.onProgress(offset, FRAME_BYTES);
      }
      s = await this.writeAck(packetCommit(id), s => s.id === id && [2, 3, 4].includes(s.state));
      const deadline = Date.now() + this.refreshTimeout;
      while (s.state !== 4) {
        if (Date.now() >= deadline) throw new Error('Display refresh timed out; check device status before retrying');
        await sleep(300);
        s = await this.readStatus();
        if (s.id !== id || s.error || s.state === 5) throw new Error(`Display update failed: ${errors[s.error] || 'unexpected status'}`);
        if (![2, 3, 4].includes(s.state)) throw new Error('Unexpected display status');
      }
      return s;
    } finally { this.busy = false; }
  }
}
