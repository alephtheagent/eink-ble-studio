// Execute production BleTransport against the native production receiver.
// Only GATT IO and driver completion are simulated; no RF or display claim.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { BleTransport } from '../web/ble.js';
const dir = await mkdtemp(join(tmpdir(), 'eink-client-smoke-'));
const executable = join(dir, 'receiver');
const built = spawnSync('g++', ['-std=c++11', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie', '-I', 'firmware/include', 'tests/v2_bridge.cpp', '-o', executable], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const results = [];
try {
  const measurements = JSON.parse(await readFile('artifacts/v2-measurements/measurements.json', 'utf8'));
  for (const row of measurements.rows) for (const ceiling of [20, 125, 244]) {
    const frame = new Uint8Array(await readFile(`artifacts/v2-measurements/${row.name}-${row.dither}.bin`));
    const child = spawn(executable, [], { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
    let pending, reply, writes = 0, maxWrite = 0, stderr = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { const resolve = pending; pending = null; resolve(line); });
    child.stderr.on('data', data => { stderr += data; });
    const exchange = text => new Promise((resolve, reject) => {
      assert.ok(pending == null, 'overlapping receiver operation');
      pending = resolve;
      child.stdin.write(text + '\n', error => { if (error) reject(error); });
    });
    const caps = Uint8Array.of(69,66,76,50,2,0,3,1,ceiling & 255,0,160,15,160,15,152,58,0,0,0,0);
    const transport = new BleTransport({
      command2: { properties: { write: true }, async writeValueWithResponse(bytes) {
        assert.ok(bytes.length <= ceiling); writes++; maxWrite = Math.max(maxWrite, bytes.length);
        reply = await exchange(`2 1 0 ${Buffer.from(bytes).toString('hex')}`);
      } },
      capabilities: { async readValue() { return new DataView(caps.buffer); } },
      status2: { async readValue() {
        if (Buffer.from(reply.split(' ')[0], 'hex')[1] === 2) reply = await exchange('R'); // Explicit simulated driver completion.
        const bytes = Buffer.from(reply.split(' ')[0], 'hex'); return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      } }
    });
    try {
      const status = await transport.send(frame, 7);
      assert.equal(status.state, 4); assert.equal(status.generation, 1);
      assert.deepEqual(Buffer.from(reply.split(' ')[1], 'hex'), Buffer.from(frame));
      assert.equal(writes, row.writes[ceiling]);
      results.push({ name: row.name, dither: row.dither, ceiling, codec: status.codec, wireBytes: status.total, writes, maxWrite, exactFrame: true });
    } finally {
      child.stdin.end();
      await new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `receiver exit ${code}`))));
      lines.close();
    }
  }
  const result = { scope: 'Production JS BleTransport to production native C++ Protocol, ASan/UBSan. GATT IO and driver return explicitly simulated; not RF or panel.', results };
  await writeFile('artifacts/v2-smoke.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
