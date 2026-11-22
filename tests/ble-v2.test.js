import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodePackBits, chooseCodec, packetStart2, packetData2, decodeCapabilities, BleTransport } from '../web/ble.js';
import { crc32 } from '../web/image.js';

const approved = new Uint8Array(fs.readFileSync(new URL('./fixtures/approved-frame.bin', import.meta.url)));
const noisy = Uint8Array.from({ length: 4000 }, (_, i) => i % 16 === 15 ? (i & 192) : i & 255);
const hex = bytes => Buffer.from(bytes).toString('hex');
const simple = (op, id = 7) => Uint8Array.of(op, id & 255, id >>> 8 & 255, id >>> 16 & 255, id >>> 24 & 255);
const status = bytes => { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { version: bytes[0], state: bytes[1], error: bytes[2], codec: bytes[3], id: v.getUint32(4, true), received: v.getUint16(8, true), total: v.getUint16(10, true), crc: v.getUint32(12, true), generation: v.getUint32(16, true) }; };
let executable, scratch;
test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eink-v2-'));
  executable = path.join(scratch, 'receiver');
  const result = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie', '-I', 'firmware/include', 'tests/v2_bridge.cpp', '-o', executable], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test.after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
function run(steps) {
  const input = steps.map(s => typeof s === 'string' ? s : `${s.v1 ? '1' : '2'} ${s.now ?? 1} ${s.conn ?? 0} ${hex(s.bytes)}`).join('\n') + '\n';
  const result = spawnSync(executable, [], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, steps.length);
  return lines.map(line => { const [s, frame] = line.split(' '); return { ...status(Buffer.from(s, 'hex')), frame: Buffer.from(frame, 'hex') }; });
}
const cmd = bytes => ({ bytes });
const start = (codec, encoded, raw = new Uint8Array(4000), id = 7, crc = crc32(raw)) => cmd(packetStart2(id, codec, 4000, encoded, crc));
const data = (offset, bytes, id = 7, ceiling = 244) => cmd(packetData2(id, offset, bytes, ceiling));
const finish = id => cmd(simple(0x13, id));
function transfer(raw, ceiling, chunk = ceiling - 7) {
  const { codec, bytes } = chooseCodec(raw);
  const steps = [start(codec, bytes.length, raw)];
  for (let offset = 0; offset < bytes.length; offset += chunk) steps.push(data(offset, bytes.subarray(offset, offset + chunk), 7, ceiling));
  steps.push(finish(7), 'R');
  return { steps, codec, bytes };
}

test('v2 codec, capabilities and framing wire contract', () => {
  assert.deepEqual([...encodePackBits(new Uint8Array(128).fill(65))], [129, 65]);
  const literal = Uint8Array.from({ length: 4000 }, (_, i) => i & 255);
  assert.equal(encodePackBits(literal).length, 4032);
  assert.equal(chooseCodec(literal).codec, 0);
  assert.deepEqual(chooseCodec(literal).bytes, literal);
  assert.deepEqual([...packetStart2(1, 1, 4000, 2, 0x12345678)], [17,1,0,0,0,1,160,15,2,0,120,86,52,18]);
  assert.deepEqual([...packetData2(1, 0, Uint8Array.of(42), 20)], [18,1,0,0,0,0,0,42]);
  const caps = Uint8Array.of(69,66,76,50,2,0,3,1,244,0,160,15,160,15,152,58,0,0,0,0);
  assert.equal(decodeCapabilities(caps).safeWrite, 244);
  for (const bad of [caps.subarray(0, 19), Uint8Array.from(caps, (v, i) => i === 4 ? 3 : v), Uint8Array.from(caps, (v, i) => i === 16 ? 1 : v)]) assert.throws(() => decodeCapabilities(bad));
});

for (const ceiling of [20, 125, 244]) test(`JS packets round trip through C++ receiver at MTU ${ceiling + 3}`, () => {
  for (const raw of [approved, new Uint8Array(4000), noisy]) {
    const { steps, bytes, codec } = transfer(raw, ceiling);
    const replies = run(steps);
    assert.equal(replies[0].version, 2);
    assert.equal(replies[0].codec, codec);
    assert.equal(replies[0].total, bytes.length);
    assert.equal(replies.at(-2).state, 2);
    assert.equal(replies.at(-2).received, bytes.length);
    assert.equal(replies.at(-1).state, 4);
    assert.equal(replies.at(-1).generation, 1);
    assert.deepEqual(replies.at(-1).frame, Buffer.from(raw));
  }
});

test('compressed tokens split at every byte and exact output length', () => {
  const raw = new Uint8Array(4000);
  const { steps, bytes } = transfer(raw, 20, 1);
  assert.ok(bytes.length < 4000);
  const replies = run(steps);
  assert.equal(replies.at(-2).error, 0);
  assert.deepEqual(replies.at(-1).frame, Buffer.from(raw));
});

test('START and COMMIT are idempotent without decoding or refreshing twice', () => {
  const raw = new Uint8Array(4000), { steps } = transfer(raw, 244);
  const initial = steps[0], commit = steps.at(-2);
  const replies = run([initial, initial, ...steps.slice(1, -2), commit, commit, 'R', commit, 'R']);
  assert.equal(replies[1].received, 0);
  assert.equal(replies.at(-5).state, 2);
  assert.equal(replies.at(-4).state, 2);
  assert.equal(replies.at(-2).state, 4);
  assert.equal(replies.at(-1).generation, 1);
});

test('malformed headers and excessive encoded lengths are rejected before input is consumed', () => {
  const invalid = packetStart2(7, 1, 4000, 1, 0);
  invalid[8] = 161; invalid[9] = 15;
  const short = Uint8Array.of(17, 7);
  const oversize = new Uint8Array(245); oversize[0] = 18;
  const replies = run([cmd(short), cmd(invalid), cmd(oversize)]);
  assert.equal(replies[0].error, 1);
  assert.equal(replies[1].error, 5);
  assert.equal(replies[2].error, 1);
  assert.ok(replies.every(s => s.received === 0 && s.state === 0));
});

test('v2 bounds, ownership, duplicate and recovery rules', () => {
  const raw = new Uint8Array(4000), a = data(0, Uint8Array.of(1)), b = data(1, Uint8Array.of(2));
  const legacyStart = new Uint8Array(11); legacyStart[0] = 1; legacyStart[1] = 8; legacyStart[5] = 160; legacyStart[6] = 15;
  const replies = run([start(0, 4000, raw), a, a, b, a, data(3, Uint8Array.of(3)), cmd(Uint8Array.of(18,7,0,0,0,159,15,1,2)), data(2, Uint8Array.of(1), 8), { ...data(2, Uint8Array.of(1)), conn: 1 }, { bytes: legacyStart, v1: true }, cmd(simple(0x14)), start(0, 4000, raw)]);
  assert.equal(replies[2].received, 1); assert.equal(replies[2].error, 0);
  assert.equal(replies[3].received, 2);
  assert.equal(replies[4].error, 4); assert.equal(replies[5].error, 4);
  assert.equal(replies[6].error, 5); assert.equal(replies[7].error, 3);
  assert.equal(replies[8].error, 2); assert.equal(replies[9].received, 2);
  assert.equal(replies[10].state, 0); assert.equal(replies[11].received, 0);
});

test('disconnect, timeout, restart and shared v1 ownership', () => {
  const raw = new Uint8Array(4000);
  const legacy = Uint8Array.of(1,8,0,0,0,160,15,0,0,0,0);
  const replies = run([start(0, 4000, raw), 'D 1', 'D 0', start(0, 4000, raw), 'T 15000', 'T 15001', { bytes: legacy, v1: true }, start(0, 4000, raw), { bytes: Uint8Array.of(4,8,0,0,0), v1: true }, start(0, 4000, raw)]);
  assert.equal(replies[1].state, 1); assert.equal(replies[2].error, 9);
  assert.equal(replies[3].state, 1); assert.equal(replies[4].state, 1); assert.equal(replies[5].error, 8);
  assert.equal(replies[7].error, 2); assert.equal(replies[9].state, 1);
});

test('malformed compressed streams, CRC and padding cannot refresh', () => {
  const zero = new Uint8Array(4000);
  const cases = [Uint8Array.of(128), Uint8Array.of(255), Uint8Array.of(2, 0), Uint8Array.from([...Array(31).fill([129,0]).flat(), 129,0])];
  for (const encoded of cases) {
    const replies = run([start(1, encoded.length, zero), data(0, encoded), finish(7), 'R']);
    assert.notEqual(replies.at(-1).state, 4);
    assert.notEqual(replies.at(-2).error, 0);
  }
  for (const [raw, crc, error] of [[zero, 123, 6], [Uint8Array.from(zero, (_, i) => i === 15 ? 1 : 0), null, 7]]) {
    const encoded = chooseCodec(raw);
    const steps = [start(encoded.codec, encoded.bytes.length, raw, 7, crc ?? crc32(raw))];
    for (let i = 0; i < encoded.bytes.length; i += 13) steps.push(data(i, encoded.bytes.subarray(i, i + 13), 7, 20));
    steps.push(finish(7), 'R');
    const replies = run(steps);
    assert.equal(replies.at(-2).error, error); assert.notEqual(replies.at(-1).state, 4);
  }
});

test('every truncated run stream prefix and trailing token is rejected', () => {
  const raw = new Uint8Array(4000), wire = encodePackBits(raw);
  for (let n = 1; n < wire.length; n++) {
    const steps = [start(1, n, raw)];
    for (let offset = 0; offset < n; offset += 13) steps.push(data(offset, wire.subarray(offset, Math.min(n, offset + 13)), 7, 20));
    steps.push(finish(7), 'R');
    const replies = run(steps);
    assert.equal(replies.at(-1).generation, 0);
    assert.equal(replies.at(-1).state, 5);
    assert.equal(replies.at(-1).error, 10);
  }
  const trailing = Uint8Array.from([...wire, 0, 0]);
  const replies = run([start(1, trailing.length, raw), data(0, trailing), finish(7), 'R']);
  assert.equal(replies.at(-1).generation, 0);
  assert.equal(replies[1].error, 10);
  assert.equal(replies[1].received, 0);
  assert.equal(replies.at(-1).state, 5);
});
