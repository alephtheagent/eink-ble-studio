import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeGif, frameFromRGBA } from './fixtures/animation/make-gif.mjs';
import { crc32, Crc32, encodeFrame, FRAME_BYTES, FrameDecoder } from '../web/anim-codec.js';

const here = new URL('.', import.meta.url);
const fixture = name => new URL(`./fixtures/animation/${name}`, import.meta.url);
const gif = readFileSync(fixture('sample.gif'));
const manifest = JSON.parse(readFileSync(fixture('frames.json'), 'utf8'));

// The site owns web/anim-gif.js; use it when it exists so this harness exercises
// the shipped decoder, and fall back to the fixture generator's strict decoder.
const siteDecoder = existsSync(new URL('../web/anim-gif.js', import.meta.url))
  ? await import('../web/anim-gif.js') : null;

function siteDecode(bytes) {
  const module = siteDecoder;
  if (!module) return null;
  const decode = module.decodeGif || module.decodeAnimatedGif || module.decode;
  assert.equal(typeof decode, 'function', 'web/anim-gif.js must export a GIF decoder');
  return decode(bytes);
}

function buildHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'eink-anim-e2e-'));
  const executable = join(dir, 'anim-e2e');
  const build = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g',
    '-Ifirmware/include', 'tests/anim_e2e.cpp', '-o', executable],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  assert.equal(build.status, 0, build.stderr);
  return { dir, executable };
}

const harness = buildHarness();

function runFirmware(commands) {
  const result = spawnSync(harness.executable, [], {
    input: commands.join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('sample.gif is a genuine 4-frame GIF89a with the documented properties', () => {
  assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
  const decoded = decodeGif(gif);
  assert.equal(decoded.width, 122);
  assert.equal(decoded.height, 250);
  assert.equal(decoded.frames.length, 4);
  assert.deepEqual(decoded.frames.map(f => f.delayMs), [120, 100, 250, 330]);
  assert.deepEqual(decoded.frames.map(f => f.disposal), [1, 2, 1, 2]);
  assert.deepEqual(decoded.frames.map(f => f.transparent), [false, true, false, true]);
  assert.deepEqual(decoded.frames.map(f => f.interlaced), [false, false, true, false]);
  assert.ok(new Set(decoded.frames.map(f => f.delayMs)).size > 1, 'delays must be non-uniform');
});

test('frames.json matches decoding sample.gif through the documented pipeline', () => {
  const decoded = decodeGif(gif);
  assert.equal(manifest.frames.length, decoded.frames.length);
  for (const [index, frame] of decoded.frames.entries()) {
    const bits = frameFromRGBA(frame.rgba);
    assert.equal(Buffer.from(bits).toString('hex'), manifest.frames[index].frameHex, `frame ${index}`);
    assert.equal(crc32(bits), manifest.frames[index].frameCrc, `frame ${index} CRC`);
    assert.equal(frame.delayMs, manifest.frames[index].delayMs, `frame ${index} delay`);
  }
});

test('unsupported.gif is rejected by every decoder in the pipeline', () => {
  const bytes = readFileSync(fixture('unsupported.gif'));
  assert.ok(bytes.length < gif.length, 'the invalid fixture must be truncated');
  assert.throws(() => decodeGif(bytes), /truncated|GIF/, 'the fixture decoder must reject it');
  if (siteDecoder) assert.throws(() => siteDecode(bytes), 'web/anim-gif.js must reject it');
});

test('GIF bytes -> 1-bit frames -> blobs -> firmware decoder -> byte-identical frames', () => {
  const decoded = decodeGif(gif);
  const frames = decoded.frames.map(frame => frameFromRGBA(frame.rgba));
  assert.equal(frames.length, 4);
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.length, FRAME_BYTES);
    for (let y = 0; y < 250; y++) assert.equal(frame[y * 16 + 15] & 0x3f, 0, `frame ${index} row ${y} padding`);
  }

  // Build the upload stream exactly as a client would: frame 0 full, rest delta.
  const blobs = [];
  let prev = null;
  const jsAnimation = new Crc32();
  for (const frame of frames) {
    const encoded = encodeFrame(prev, frame);
    blobs.push(encoded.blob);
    jsAnimation.update(frame);
    prev = frame;
  }

  const commands = ['R'];
  for (const blob of blobs) commands.push(`F ${Buffer.from(blob).toString('hex')}`);
  for (const frame of frames) commands.push(`A ${Buffer.from(frame).toString('hex')}`);
  commands.push('C');
  const output = runFirmware(commands);

  const reset = output.shift();
  assert.equal(reset, 'OK');
  for (const [index, line] of output.slice(0, blobs.length).entries()) {
    const [status, crcText, frameHex] = line.split(' ');
    assert.equal(status, '0', `frame ${index} decode status`);
    assert.equal(crcText, crc32(frames[index]).toString(16).padStart(8, '0'), `frame ${index} CRC`);
    assert.equal(frameHex, Buffer.from(frames[index]).toString('hex'), `frame ${index} must be byte identical`);
  }
  const acks = output.slice(blobs.length, blobs.length + frames.length);
  assert.deepEqual(acks, frames.map(() => 'OK'));
  const firmwareAnimation = output[output.length - 1];
  assert.equal(firmwareAnimation, jsAnimation.value().toString(16).padStart(8, '0'), 'animation CRC must agree');
});

test('firmware decoder reproduces the committed vector blobs', () => {
  const vectors = JSON.parse(readFileSync(new URL('./vectors-animation.json', import.meta.url), 'utf8'));
  const frame = index => Uint8Array.from(Buffer.from(vectors.frames[index].hex, 'hex'));
  // Each vector states the frame index it must decode from. Prime the firmware
  // decoder with that exact previous frame (or a reset when there is none), then
  // feed the blob under test.
  const commands = [];
  const expectations = [];
  for (const vector of vectors.blobs) {
    // Every vector is decoded from a known starting state: reset, prime the
    // previous frame when one is required, then feed the blob under test.
    commands.push('R');
    expectations.push(null);
    if (vector.prev !== null) {
      commands.push(`S ${vectors.frames[vector.prev].hex}`);
      expectations.push(null);
    }
    commands.push(`F ${vector.blobHex}`);
    expectations.push(vector);
  }
  const output = runFirmware(commands);
  assert.equal(output.length, expectations.length, 'one reply per command');
  for (const [index, expectation] of expectations.entries()) {
    if (!expectation) {
      assert.equal(output[index], 'OK', 'reset and priming must succeed');
      continue;
    }
    const [status, crcText, frameHex] = output[index].split(' ');
    assert.equal(status, '0', `${expectation.name} status`);
    assert.equal(crcText, crc32(frame(expectation.frame)).toString(16).padStart(8, '0'), expectation.name);
    assert.equal(frameHex, vectors.frames[expectation.frame].hex, expectation.name);
  }
});

test('firmware decoder rejects a corrupted and a truncated blob', () => {
  const frame = Uint8Array.from(Buffer.from(manifest.frames[0].frameHex, 'hex'));
  const good = encodeFrame(null, frame).blob;
  const corrupt = Uint8Array.from(good);
  corrupt[corrupt.length - 1] ^= 0x01;
  const output = runFirmware([
    `F ${Buffer.from(corrupt).toString('hex')}`,
    `F ${Buffer.from(good.subarray(0, 20)).toString('hex')}`,
    `F ${Buffer.from(good).toString('hex')}`,
  ]);
  const [corruptStatus] = output[0].split(' ');
  const [truncatedStatus] = output[1].split(' ');
  const [goodStatus, , goodHex] = output[2].split(' ');
  assert.notEqual(corruptStatus, '0', 'a flipped payload bit must be rejected');
  assert.equal(truncatedStatus, '2', 'a truncated blob is a length error');
  assert.equal(goodStatus, '0', 'the good blob still decodes after failures');
  assert.equal(goodHex, manifest.frames[0].frameHex);
});

test('JS FrameDecoder and the firmware decoder agree frame for frame', () => {
  const decoded = decodeGif(gif);
  const frames = decoded.frames.map(frame => frameFromRGBA(frame.rgba));
  const decoder = new FrameDecoder();
  const commands = [];
  let prev = null;
  for (const frame of frames) {
    const blob = encodeFrame(prev, frame).blob;
    const pushed = decoder.push(blob);
    assert.equal(Buffer.from(pushed.bytes).toString('hex'), Buffer.from(frame).toString('hex'));
    commands.push(`F ${Buffer.from(blob).toString('hex')}`);
    prev = frame;
  }
  const output = runFirmware(commands);
  for (const [index, line] of output.entries()) {
    assert.equal(line.split(' ')[2], Buffer.from(frames[index]).toString('hex'), `frame ${index}`);
  }
});

test('e2e harness exits cleanly on an empty stream', () => {
  const output = runFirmware(['C']);
  assert.equal(output.length, 1);
  assert.equal(output[0], '00000000');
});

process.on('exit', () => rmSync(harness.dir, { recursive: true, force: true }));
