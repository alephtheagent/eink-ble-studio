import test from 'node:test';
import assert from 'node:assert/strict';
import { BleTransport, UUIDS } from '../web/ble.js';

function fake({ ceiling = 244, missing = false, discoveryError = false, badCaps = false, badAck = false, disconnectData = false, hangData = false, queued = false } = {}) {
  const state = { writes: [], reads: 0, commits: 0, id: 0, offset: 0, total: 0, crc: 0, codec: 0, phase: 0, generation: 0 };
  const device = { gatt: { connected: false, disconnect() { this.connected = false; } }, addEventListener() {}, removeEventListener() {} };
  function status(version) {
    const b = new Uint8Array(20), v = new DataView(b.buffer);
    b[0] = version; b[1] = state.phase; b[3] = version === 2 ? state.codec : 0;
    v.setUint32(4, state.id, true); v.setUint16(8, state.offset, true); v.setUint16(10, version === 2 ? state.total : 4000, true);
    v.setUint32(12, state.crc, true); v.setUint32(16, state.generation, true);
    if (badAck && state.writes.at(-1)?.[0] === 0x12) v.setUint16(8, state.offset - 1, true);
    return v;
  }
  const command2 = { properties: { write: true }, async writeValueWithResponse(value) {
    const b = Uint8Array.from(value), v = new DataView(b.buffer); state.writes.push(b);
    if (b[0] === 0x11) { state.id = v.getUint32(1, true); state.codec = b[5]; state.total = v.getUint16(8, true); state.crc = v.getUint32(10, true); state.offset = 0; state.phase = 1; }
    if (b[0] === 0x12) { if (hangData) return new Promise(() => {}); if (disconnectData) { device.gatt.disconnect(); throw new Error('link lost'); } state.offset += b.length - 7; }
    if (b[0] === 0x13) { state.commits++; state.phase = queued ? 2 : 4; if (!queued) state.generation++; }
  } };
  const command = { properties: { write: true }, async writeValueWithResponse(value) {
    const b = Uint8Array.from(value), v = new DataView(b.buffer); state.writes.push(b);
    if (b[0] === 1) { state.id = v.getUint32(1, true); state.crc = v.getUint32(7, true); state.offset = 0; state.phase = 1; }
    if (b[0] === 2) state.offset += b.length - 7;
    if (b[0] === 3) { state.commits++; state.phase = 4; state.generation++; }
  } };
  const caps = { async readValue() {
    state.reads++;
    const b = Uint8Array.of(69,66,76,50,2,0,3,1,0,0,160,15,160,15,152,58,0,0,0,0);
    new DataView(b.buffer).setUint16(8, ceiling, true); if (badCaps) b[4] = 3; return new DataView(b.buffer);
  } };
  const chars = { [UUIDS.command]: command, [UUIDS.status]: { async readValue() { return status(1); } }, [UUIDS.command2]: command2, [UUIDS.status2]: { async readValue() { return status(2); } }, [UUIDS.capabilities]: caps };
  const service = { async getCharacteristic(uuid) {
    if (uuid === UUIDS.capabilities && (missing || discoveryError)) { const e = new Error('discovery failed'); e.name = missing ? 'NotFoundError' : 'NetworkError'; throw e; }
    return chars[uuid];
  } };
  const server = { async getPrimaryService() { return service; } };
  device.gatt.connect = async () => { device.gatt.connected = true; return server; };
  return { state, device, bluetooth: { async requestDevice() { return device; } }, setCeiling(n) { ceiling = n; } };
}

test('v2 discovery and negotiated ceilings are reread for each transfer', async () => {
  const f = fake({ ceiling: 125 }), c = new BleTransport({ bluetooth: f.bluetooth });
  await c.connect();
  await c.send(new Uint8Array(4000), 7);
  assert.equal(f.state.commits, 1);
  assert.ok(f.state.writes.every(b => b.length <= 125));
  assert.ok(f.state.writes.some(b => b[0] === 0x12));
  f.setCeiling(20); f.state.writes.length = 0;
  await c.send(new Uint8Array(4000), 8);
  assert.ok(f.state.reads >= 2);
  assert.ok(f.state.writes.every(b => b.length <= 20));
  assert.equal(f.state.commits, 2);
});

test('capability absence falls back, discovery and corrupt capabilities do not', async () => {
  const old = fake({ missing: true });
  const client = new BleTransport({ bluetooth: old.bluetooth });
  await client.connect();
  assert.ok(client.command); assert.ok(client.status);
  await client.send(new Uint8Array(4000), 3);
  assert.equal(old.state.commits, 1);
  assert.ok(old.state.writes.every(b => b.length <= 20 && b[0] < 0x10));
  for (const options of [{ discoveryError: true }, { badCaps: true }]) {
    const f = fake(options), c = new BleTransport({ bluetooth: f.bluetooth });
    await assert.rejects(async () => { await c.connect(); await c.send(new Uint8Array(4000), 1); });
    assert.equal(f.state.writes.length, 0);
  }
});

test('bad v2 acknowledgement or disconnect never produces a successful commit', async () => {
  for (const options of [{ badAck: true }, { disconnectData: true }]) {
    const f = fake(options), c = new BleTransport({ bluetooth: f.bluetooth });
    await c.connect();
    await assert.rejects(c.send(new Uint8Array(4000), 9));
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.phase, 1);
  }
});

test('queued COMMIT is not display success and uncertain DATA is not retried', async () => {
  for (const options of [{ queued: true }, { hangData: true }]) {
    const f = fake(options), c = new BleTransport({ bluetooth: f.bluetooth, timeout: 20, refreshTimeout: 0 });
    await c.connect();
    await assert.rejects(c.send(new Uint8Array(4000), 10), /timed out/i);
    assert.equal(f.device.gatt.connected, false);
    assert.equal(f.state.generation, 0);
    assert.equal(f.state.writes.filter(b => b[0] === 0x12).length, 1);
  }
});

test('reconnect discards previous ceiling and explicit force20 bounds a restarted attempt', async () => {
  const f = fake(), c = new BleTransport({ bluetooth: f.bluetooth });
  await c.connect(); await c.send(new Uint8Array(4000), 11);
  c.disconnect(); f.setCeiling(20); f.state.writes.length = 0;
  await c.connect(); await c.send(new Uint8Array(4000), 12);
  assert.ok(f.state.writes.every(b => b.length <= 20));
  c.disconnect(); f.setCeiling(244); f.state.writes.length = 0; c.force20 = true;
  await c.connect(); await c.send(new Uint8Array(4000), 13);
  assert.ok(f.state.writes.every(b => b.length <= 20));
  assert.equal((await c.readStatus()).id, 13);
  assert.equal((await c.readStatus()).version, 2);
});

test('legacy write API is allowed only with unambiguous response-only properties', async () => {
  for (const ambiguous of [false, true]) {
    const f = fake(), c = new BleTransport({ bluetooth: f.bluetooth });
    await c.connect();
    const command = c.command2;
    command.writeValue = command.writeValueWithResponse;
    delete command.writeValueWithResponse;
    command.properties.writeWithoutResponse = ambiguous;
    if (ambiguous) {
      await assert.rejects(c.send(new Uint8Array(4000), 14), /response-confirmed/);
      assert.equal(f.state.writes.length, 0);
    } else assert.equal((await c.send(new Uint8Array(4000), 14)).state, 4);
  }
});
