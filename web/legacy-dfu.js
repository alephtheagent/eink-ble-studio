// Adafruit / Nordic legacy BLE DFU 0.5, application-only, no dependencies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LegacyDfu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SERVICE = '00001530-1212-efde-1523-785feabcd123';
  const CONTROL = '00001531-1212-efde-1523-785feabcd123';
  const PACKET = '00001532-1212-efde-1523-785feabcd123';
  const statuses = { 2: 'Invalid state', 3: 'Not supported', 4: 'Data size exceeds limit', 5: 'CRC error', 6: 'Operation failed' };
  const bytes = value => ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);

  class LegacyDfu {
    constructor({ bluetooth, prn = 8, chunk = 20, onLog = () => {}, onProgress = () => {}, timeout = 10000 } = {}) {
      if (!Number.isInteger(prn) || prn < 1 || prn > 8) throw new RangeError('Legacy DFU PRN must be between 1 and 8.');
      if (!Number.isInteger(chunk) || chunk < 1 || chunk > 20) throw new RangeError('Legacy DFU chunks must be between 1 and 20 bytes.');
      if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Legacy DFU timeout must be positive.');
      Object.assign(this, { bluetooth, prn, chunk, onLog, onProgress, timeout });
      this.running = false;
    }

    abort() {
      if (!this.running) return;
      this.fail(new Error('Legacy DFU cancelled.'));
      this.device.gatt.disconnect();
    }

    fail(error) {
      if (this.error) return;
      this.error = error;
      for (const pending of [...this.pending]) pending.reject(error);
    }

    // All GATT calls and response waits are bounded, including service discovery.
    wait(label, start) {
      if (this.error) throw this.error;
      let pending;
      const promise = new Promise((resolve, reject) => {
        const finish = (fn, value) => {
          clearTimeout(pending.timer);
          this.pending.delete(pending);
          fn(value);
        };
        pending = {
          resolve: value => finish(resolve, value),
          reject: error => finish(reject, error),
        };
        pending.timer = setTimeout(() => this.fail(new Error(`Legacy DFU timeout: ${label}.`)), this.timeout);
        this.pending.add(pending);
        if (start) Promise.resolve().then(start).then(pending.resolve, pending.reject);
      });
      // A synchronous notification may reject before its triggering write settles.
      promise.catch(() => {});
      return { promise, pending };
    }

    response(opcode, receiptBytes = null) {
      const waiter = this.wait(`response for opcode 0x${opcode.toString(16)}`);
      const queue = this.responses.get(opcode) || [];
      queue.push({ ...waiter.pending, receiptBytes });
      this.responses.set(opcode, queue);
      return waiter.promise;
    }

    notify(event) {
      const data = bytes(event.target.value);
      if (data[0] === 0x10 && data.length >= 3) {
        const opcode = data[1];
        if (data[2] !== 1) {
          this.fail(new Error(`Legacy DFU opcode 0x${opcode.toString(16)}: ${statuses[data[2]] || 'Unknown status'} (${data[2]}).`));
          return;
        }
        const queue = this.responses.get(opcode);
        queue?.shift()?.resolve();
      } else if (data[0] === 0x11 && data.length >= 5) {
        const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
        const queue = this.responses.get(3);
        // A receipt cannot substitute for the final RECEIVE response.
        if (queue?.[0]?.receiptBytes === count) queue.shift().resolve();
      }
    }

    async update(device, { init, firmware }) {
      if (this.running) throw new Error('Legacy DFU update already running.');
      const initBytes = bytes(init);
      const image = bytes(firmware);
      if (!initBytes.length || !image.length) throw new Error('Legacy DFU requires nonempty init and firmware.');
      this.running = true;
      this.device = device;
      this.error = null;
      this.pending = new Set();
      this.responses = new Map();
      let control;
      let activating = false;
      let activation;
      const disconnected = () => {
        if (activating) activation?.resolve();
        else this.fail(new Error('Legacy DFU connection was lost (disconnected).'));
      };
      const notified = event => this.notify(event);
      const call = (label, fn) => this.wait(label, fn).promise;
      const write = (characteristic, data) => call('GATT write', () => {
        if (this.error) throw this.error;
        if (characteristic !== control && characteristic.writeValueWithoutResponse) return characteristic.writeValueWithoutResponse(data);
        return characteristic.writeValueWithResponse
          ? characteristic.writeValueWithResponse(data) : characteristic.writeValue(data);
      });
      device.addEventListener('gattserverdisconnected', disconnected);
      try {
        this.onLog('Legacy DFU 0.5 (Adafruit), PRN ' + this.prn);
        const connection = device.gatt.connect();
        // A connection may finish after cancellation or timeout.
        Promise.resolve(connection).then(() => { if (this.error) device.gatt.disconnect(); }, () => {});
        const server = await call('GATT connect', () => connection);
        const service = await call('DFU service discovery', () => server.getPrimaryService(SERVICE));
        control = await call('control discovery', () => service.getCharacteristic(CONTROL));
        const packet = await call('packet discovery', () => service.getCharacteristic(PACKET));
        control.addEventListener('characteristicvaluechanged', notified);
        await call('start notifications', () => control.startNotifications());

        const size = new Uint8Array(12);
        new DataView(size.buffer).setUint32(8, image.length, true);
        const started = this.response(1);
        await write(control, Uint8Array.of(1, 4));
        await write(packet, size);
        await started;
        await write(control, Uint8Array.of(2, 0));
        for (let i = 0; i < initBytes.length; i += this.chunk) await write(packet, initBytes.subarray(i, i + this.chunk));
        const initialized = this.response(2);
        await write(control, Uint8Array.of(2, 1));
        await initialized;
        await write(control, Uint8Array.of(8, this.prn, 0));
        await write(control, Uint8Array.of(3));
        this.onProgress(0, image.length);
        let packets = 0;
        for (let offset = 0; offset < image.length; offset += this.chunk) {
          const end = Math.min(offset + this.chunk, image.length);
          const final = end === image.length;
          const boundary = ++packets % this.prn === 0;
          const received = (final || boundary) ? this.response(3, final ? null : end) : null;
          await write(packet, image.subarray(offset, end));
          if (received) await received;
          this.onProgress(end, image.length);
        }
        const validated = this.response(4);
        await write(control, Uint8Array.of(4));
        await validated;
        this.onLog('Legacy DFU validated; activating firmware.');
        const reset = this.wait('firmware activation');
        activation = reset.pending;
        activating = true;
        Promise.resolve().then(() => {
          if (this.error) throw this.error;
          return control.writeValueWithResponse
            ? control.writeValueWithResponse(Uint8Array.of(5)) : control.writeValue(Uint8Array.of(5));
        }).then(activation.resolve, error => {
          // The reset can disconnect GATT before the ATT write acknowledgement.
          if (!device.gatt.connected) activation.resolve();
          else activation.reject(error);
        });
        await reset.promise;
        if (this.error) throw this.error;
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        device.removeEventListener('gattserverdisconnected', disconnected);
        control?.removeEventListener('characteristicvaluechanged', notified);
        this.running = false;
        this.responses.clear();
        if (device.gatt.connected) device.gatt.disconnect();
      }
    }
  }
  return LegacyDfu;
});
