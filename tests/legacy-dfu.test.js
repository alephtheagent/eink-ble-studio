import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const firmware = fs.readFileSync(new URL('./fixtures/legacy-dfu.bin', import.meta.url));
const init = fs.readFileSync(new URL('./fixtures/legacy-dfu.dat', import.meta.url));
const UUID = n => `0000153${n}-1212-efde-1523-785feabcd123`;

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

function loadTransport() {
  const context = { setTimeout, clearTimeout, console, Uint8Array, DataView, ArrayBuffer, DOMException };
  vm.runInNewContext(fs.readFileSync(new URL('../web/legacy-dfu.js', import.meta.url), 'utf8'), context);
  return context.LegacyDfu;
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, target: this, ...event });
  }
}

// A strict bootloader model: writes out of order, or across an unacknowledged
// packet receipt boundary, fail immediately rather than silently succeeding.
function bootloader(options = {}) {
  const device = new Events();
  device.name = 'DFU';
  device.id = 'legacy-bootloader';
  const control = new Events();
  const packet = new Events();
  const controls = [];
  const initBytes = [];
  const image = [];
  const receipts = [];
  let state = 'start', size = 0, prn = 0, packets = 0, waiting = false;
  let subscribed = false;
  const notify = bytes => {
    if (options.silent) return;
    assert.ok(subscribed, 'notifications must be enabled before a response');
    const deliver = () => {
      waiting = false;
      const value = Uint8Array.from(bytes);
      control.value = new DataView(value.buffer);
      control.emit('characteristicvaluechanged');
    };
    if (options.asyncNotifications) setTimeout(deliver, 0);
    else deliver();
  };
  const response = (opcode, status = 1) => notify([0x10, opcode, options.errorOpcode === opcode ? 4 : status]);
  control.startNotifications = async () => { subscribed = true; return control; };
  control.stopNotifications = async () => { subscribed = false; return control; };
  control.writeValueWithResponse = async value => {
    const bytes = Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    controls.push(bytes);
    const key = bytes.join(',');
    if (state === 'start') {
      assert.equal(key, '1,4'); state = 'size';
    } else if (state === 'init-start') {
      assert.equal(key, '2,0'); state = 'init';
    } else if (state === 'init') {
      assert.equal(key, '2,1'); assert.deepEqual(initBytes, [...init]); state = 'prn'; response(2);
    } else if (state === 'prn') {
      assert.equal(bytes[0], 8); assert.equal(bytes.length, 3);
      prn = bytes[1] | bytes[2] << 8; assert.equal(prn, 8); state = 'receive';
    } else if (state === 'receive') {
      assert.equal(key, '3'); state = 'image';
      if (options.disconnectOnReceive) device.gatt.disconnect();
      options.onReceive?.();
    } else if (state === 'validate') {
      assert.equal(key, '4'); state = 'activate';
      response(4, crc16(image) === (initBytes.at(-2) | initBytes.at(-1) << 8) ? 1 : 5);
    } else if (state === 'activate') {
      assert.equal(key, '5'); state = 'done';
      if (options.activationDisconnect) device.gatt.disconnect();
    } else assert.fail(`unexpected control write ${key} in ${state}`);
  };
  packet.writeValueWithoutResponse = async value => {
    const bytes = Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    assert.ok(bytes.length > 0 && bytes.length <= 20);
    if (state === 'size') {
      assert.equal(bytes.length, 12);
      const view = new DataView(Uint8Array.from(bytes).buffer);
      assert.equal(view.getUint32(0, true), 0); assert.equal(view.getUint32(4, true), 0);
      size = view.getUint32(8, true); assert.equal(size, options.expectedSize ?? firmware.length);
      state = 'init-start'; response(1);
    } else if (state === 'init') {
      initBytes.push(...bytes);
    } else if (state === 'image') {
      assert.equal(waiting, false, 'sent firmware before PRN');
      image.push(...bytes); packets++;
      assert.ok(image.length <= size);
      if (image.length === size) { state = 'validate'; response(3); }
      else if (packets % prn === 0) {
        waiting = true; receipts.push(image.length);
        if (options.legacyPrn) notify([0x10, 3, 1]);
        else notify([0x11, image.length & 255, image.length >> 8 & 255, image.length >> 16 & 255, image.length >> 24 & 255]);
      }
    } else assert.fail(`unexpected packet in ${state}`);
  };
  control.writeValue = control.writeValueWithResponse;
  control.writeValueWithoutResponse = control.writeValueWithResponse;
  packet.writeValue = packet.writeValueWithoutResponse;
  const service = { async getCharacteristic(uuid) {
    assert.ok([UUID(1), UUID(2)].includes(String(uuid).toLowerCase()), `unexpected characteristic ${uuid}`);
    return String(uuid).toLowerCase() === UUID(1) ? control : packet;
  } };
  const server = { async getPrimaryService(uuid) { assert.equal(String(uuid).toLowerCase(), UUID(0)); return service; } };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return server; },
    disconnect() { if (this.connected) { this.connected = false; device.emit('gattserverdisconnected'); } },
  };
  return { device, controls, image, receipts, get state() { return state; } };
}

function transport(fake, options = {}) {
  const LegacyDfu = loadTransport();
  return new LegacyDfu({ bluetooth: {}, timeout: 100, ...options });
}

const expectedControls = [[1, 4], [2, 0], [2, 1], [8, 8, 0], [3], [4], [5]];

test('real firmware completes with strict state machine and paced Nordic PRNs', async () => {
  assert.equal(firmware.length, 146712);
  assert.equal(crc16(firmware), init.readUInt16LE(init.length - 2));
  const fake = bootloader({ asyncNotifications: true, activationDisconnect: true });
  await transport(fake, { timeout: 2000 }).update(fake.device, { init, firmware });
  assert.deepEqual(fake.controls, expectedControls);
  assert.deepEqual(Buffer.from(fake.image), firmware);
  assert.equal(fake.receipts.length, Math.floor((Math.ceil(firmware.length / 20) - 1) / 8));
  assert.equal(fake.state, 'done');
});

test('synchronous response notifications and legacy PRN response form are not lost', async () => {
  const fake = bootloader({ legacyPrn: true });
  await transport(fake).update(fake.device, { init, firmware });
  assert.deepEqual(fake.controls, expectedControls);
});

test('exact PRN multiple accepts final receive response without an extra receipt', async () => {
  // A deliberately truncated image fails CRC only after the final response; reaching
  // validation demonstrates that the sender did not wait for a non-existent PRN.
  const image = firmware.subarray(0, 160);
  const fake = bootloader({ expectedSize: image.length });
  await assert.rejects(transport(fake).update(fake.device, { init, firmware: image }));
  assert.deepEqual(fake.controls, expectedControls.slice(0, 6));
  assert.equal(fake.receipts.length, 0);
});

test('corrupted firmware is rejected by bootloader CRC validation', async () => {
  const image = Buffer.from(firmware); image[17] ^= 1;
  const fake = bootloader();
  await assert.rejects(transport(fake).update(fake.device, { init, firmware: image }));
  assert.deepEqual(fake.controls, expectedControls.slice(0, 6));
});

test('non-success control response stops the transfer', async () => {
  const fake = bootloader({ errorOpcode: 2 });
  await assert.rejects(transport(fake).update(fake.device, { init, firmware }));
  assert.deepEqual(fake.controls, expectedControls.slice(0, 3));
});

test('unexpected disconnect rejects the transfer', async () => {
  const fake = bootloader({ disconnectOnReceive: true });
  await assert.rejects(transport(fake).update(fake.device, { init, firmware }));
  assert.deepEqual(fake.controls, expectedControls.slice(0, 5));
});

test('missing notification times out', async () => {
  const fake = bootloader({ silent: true });
  await assert.rejects(transport(fake, { timeout: 15 }).update(fake.device, { init, firmware }));
  assert.deepEqual(fake.controls, [[1, 4]]);
});

test('abort cancels an update waiting for a notification', async () => {
  const fake = bootloader({ silent: true });
  const dfu = transport(fake, { timeout: 1000 });
  const update = dfu.update(fake.device, { init, firmware });
  await new Promise(resolve => setTimeout(resolve, 10));
  dfu.abort();
  await assert.rejects(update);
  assert.deepEqual(fake.controls, [[1, 4]]);
});
