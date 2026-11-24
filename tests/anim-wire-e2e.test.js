// Wire-level end-to-end test: the exact bytes the SITE puts on the animation command
// characteristic are delivered to the real firmware endpoint (anim_wire.h) and the
// acknowledgements and read-back are verified.
//
// This closes the one gap the codec/vector tests cannot close: agreement on DATA offset
// semantics (payload-only, 0..encLen), field order in BEGIN/FRAME, ack values, and the
// READ data-characteristic framing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packetBegin, packetFrame, packetData, packetFrameCommit, packetCommit, packetPlay,
  packetRead, animationCrc, decodeAnimStatus,
} from '../web/anim.js';
import { decodeGif, frameFromRGBA } from './fixtures/animation/make-gif.mjs';
import { crc32, encodeFrame, decodeBlob, Crc32, FRAME_BYTES, KIND_FULL } from '../web/anim-codec.js';

const gif = readFileSync(new URL('./fixtures/animation/sample.gif', import.meta.url));
const frames = decodeGif(gif).frames.map(frame => frameFromRGBA(frame.rgba));
const delays = decodeGif(gif).frames.map(frame => frame.delayMs);

const dir = mkdtempSync(join(tmpdir(), 'eink-anim-wire-'));
const executable = join(dir, 'anim-endpoint-e2e');
const build = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror',
  '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g',
  '-Ifirmware/include', 'tests/anim_endpoint_e2e.cpp', '-o', executable],
  { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
assert.equal(build.status, 0, `harness build failed:\n${build.stderr}`);

const hex = bytes => Buffer.from(bytes).toString('hex');

// Data chunks stay within the MTU-23 case (safeWrite 20, payload 17), the smallest the
// protocol must support.
const PAYLOAD_MAX = 17;

// `includeHeader` reproduces the exact client bug this test exists to catch: FRAME still
// declares the correct payload-only encLen, but DATA carries the whole stored blob
// (header included) at whole-blob offsets, so every payload is shifted by 8 bytes.
function uploadStream(frameList, frameDelays, { includeHeader = false } = {}) {
  const payloadMax = PAYLOAD_MAX;
  const crc = animationCrc(frameList);
  const commands = [packetBegin(0, frameList.length, 1, crc)];
  let previous = null;
  for (const [index, frame] of frameList.entries()) {
    const encoded = encodeFrame(previous, frame);
    const payload = encoded.blob.subarray(8);
    const sent = includeHeader ? encoded.blob : payload;
    commands.push(packetFrame(index, encoded.kind, payload.length, encoded.crc, frameDelays[index]));
    for (let offset = 0; offset < sent.length; offset += payloadMax) {
      commands.push(packetData(offset, sent.subarray(offset, Math.min(offset + payloadMax, sent.length))));
    }
    commands.push(packetFrameCommit());
    previous = frame;
  }
  commands.push(packetCommit());
  return { commands, crc };
}

// Runs the harness with a command list and returns parsed replies (hex lines only).
function drive(lines) {
  const result = spawnSync(executable, [], {
    input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
  });
  assert.equal(result.status, 0, `harness exit: ${result.stderr}`);
  // Reply lines are "<err> <rev> <count> <index> <dataBytes> <animcrc> <flags> <statusHex> <dataHex>".
  return result.stdout.trim().split('\n').filter(line => /^\d+ \d+ \d+ \d+ \d+ \d+ \d+ [0-9a-f]{40} (-|[0-9a-f]+)$/.test(line));
}

const commandLine = bytes => `C ${hex(bytes)}`;
const parse = line => {
  const [error, rev, count, index, dataBytes, animCrc, flags, statusHex, dataHex] = line.split(' ');
  return {
    error: Number(error), revision: Number(rev), count: Number(count), index: Number(index),
    dataBytes: Number(dataBytes), animCrc: Number(animCrc), flags: Number(flags),
    status: decodeAnimStatus(Buffer.from(statusHex, 'hex')),
    data: dataHex, rawData: Buffer.from(dataHex === '-' ? '' : dataHex, 'hex'),
  };
};

test('the site upload stream is accepted by the firmware endpoint, ack by ack', () => {
  const { commands, crc } = uploadStream(frames, delays);
  const replies = drive(commands.map(commandLine));
  assert.equal(replies.length, commands.length, 'one reply per command');

  let cursor = 0;
  const begin = parse(replies[cursor++]);
  assert.equal(commands[0][0], 0x02);
  assert.equal(begin.error, 0, 'BEGIN accepted');
  assert.equal(begin.index, 0, 'BEGIN acks index 0 (next frame to commit)');

  let previous = null;
  for (const [index, frame] of frames.entries()) {
    const encoded = encodeFrame(previous, frame);
    const payload = encoded.blob.subarray(8);

    const frameReply = parse(replies[cursor++]);
    assert.equal(frameReply.error, 0, `FRAME ${index} accepted`);
    assert.equal(frameReply.index, index, `FRAME ${index} acks its index`);
    assert.equal(frameReply.status.op, 0x03);

    for (let offset = 0; offset < payload.length; offset += PAYLOAD_MAX) {
      const length = Math.min(PAYLOAD_MAX, payload.length - offset);
      const reply = parse(replies[cursor++]);
      assert.equal(reply.error, 0, `DATA ${index}@${offset} accepted`);
      assert.equal(reply.index, offset + length,
        `DATA ${index}@${offset} must ack the exact next PAYLOAD offset (${offset + length}), not ${offset}`);
    }

    const commitReply = parse(replies[cursor++]);
    assert.equal(commitReply.error, 0, `FRAME_COMMIT ${index} accepted`);
    // The ack is the next index still to commit, or 0xFFFF once every frame is stored.
    const next = index + 1 < frames.length ? index + 1 : 0xFFFF;
    assert.equal(commitReply.index, next, `FRAME_COMMIT ${index} acks ${next}`);
    previous = frame;
  }

  const finalReply = parse(replies[cursor++]);
  assert.equal(finalReply.error, 0, 'COMMIT accepted');
  assert.equal(finalReply.revision, 1, 'COMMIT acks revision 1');
  assert.equal(finalReply.count, frames.length, 'COMMIT acks the durable frame count');
  assert.equal(finalReply.animCrc, crc, 'COMMIT acks the animation CRC the site computed');
  assert.equal(finalReply.animCrc, new Crc32().update(frames[0]).update(frames[1]).update(frames[2]).update(frames[3]).value(),
    'and it equals a JS Crc32 fold over the decoded frames');
});

test('every stored frame reads back through READ byte for byte', () => {
  const upload = uploadStream(frames, delays);
  const uploadLines = upload.commands.map(commandLine);

  // Pass 1: READ(index, 0) reports blobLen in status.dataBytes, exactly as documented.
  const lengths = drive([...uploadLines, ...frames.map((_, index) => commandLine(packetRead(index, 0)))])
    .slice(upload.commands.length).map(parse);
  const blobLens = lengths.map(reply => {
    assert.equal(reply.error, 0, 'READ 0 accepted');
    return reply.dataBytes;
  });
  for (const [index, blobLen] of blobLens.entries()) {
    assert.ok(blobLen > 8 && blobLen <= 4008, `frame ${index} blobLen ${blobLen} is 8 + encLen`);
  }

  // Pass 2: read every blob at exact 18-byte strides, then EOF at offset == blobLen.
  const readLines = [];
  for (const [index, blobLen] of blobLens.entries()) {
    // Chunks at 0, 18, 36, ... while bytes remain, then one EOF read at exactly blobLen.
    for (let offset = 0; offset < blobLen; offset += 18) readLines.push(commandLine(packetRead(index, offset)));
    readLines.push(commandLine(packetRead(index, blobLen)));
  }
  const replies = drive([...uploadLines, ...readLines]).slice(upload.commands.length).map(parse);

  let cursor = 0;
  for (const [index, blobLen] of blobLens.entries()) {
    const blob = [];
    for (;;) {
      const reply = replies[cursor++];
      assert.equal(reply.error, 0, `READ ${index}@${blob.length} accepted`);
      assert.equal(reply.index, index, 'READ acks the requested frame index');
      const offset = reply.rawData.readUInt16LE(0);
      assert.equal(offset, blob.length, 'READ returned the offset we asked for');
      if (offset === blobLen) {
        assert.equal(reply.rawData.length, 2, 'EOF returns only the offset, no payload');
        break;
      }
      const chunk = reply.rawData.subarray(2);
      assert.ok(chunk.length > 0 && chunk.length <= 18, 'READ payload is 1..18 bytes');
      assert.equal(chunk.length, Math.min(18, blobLen - offset), 'READ returns a full chunk');
      blob.push(...chunk);
      if (blob.length > 4008) throw new Error('READ did not terminate');
    }
    assert.equal(blob.length, blobLen, 'accumulated blob length equals status.dataBytes');
    assert.equal(blobLen, 8 + (blob[2] | (blob[3] << 8)), 'blobLen is 8 + encLen');
    assert.equal(blob[0], index === 0 ? KIND_FULL : blob[0], 'frame 0 is stored as a full frame');

    // Decode the read-back blob and compare to the local 1-bit frame.
    const decoded = decodeBlob(Uint8Array.from(blob), index ? frames[index - 1] : null);
    assert.equal(hex(decoded.bytes), hex(frames[index]), `frame ${index} read back byte for byte`);
  }
  assert.equal(cursor, replies.length, 'no READ reply left over');
});

test('DATA with whole-blob (header-included) offsets is rejected, proving the harness catches it', () => {
  const { commands } = uploadStream(frames, delays, { includeHeader: true });
  const replies = drive(commands.map(commandLine)).map(parse);
  // The upload must fail: the firmware expects payload-only offsets, so the extra 8 bytes
  // are an overrun (error 11 limit) or an offset mismatch (error 8 offset) on the first
  // frame, and the animation must never commit.
  const errors = replies.map(reply => reply.error);
  assert.ok(errors.includes(8) || errors.includes(11),
    `expected error 8 (offset) or 11 (limit) somewhere in the stream, saw: ${errors.join(',')}`);
  const last = replies[replies.length - 1];
  assert.equal(last.count, 0, 'no animation is durable after a rejected upload');
  assert.equal(last.revision, 0, 'revision did not advance');
});

test('PLAY after a successful upload sets the playing flag and acks the start index', () => {
  const upload = uploadStream(frames, delays);
  const replies = drive([...upload.commands.map(commandLine), commandLine(packetPlay(0))]).map(parse);
  const play = replies[replies.length - 1];
  assert.equal(play.error, 0, 'PLAY accepted');
  assert.equal(play.flags & 0x02, 0x02, 'status flags bit 1 reports playback');
  assert.equal(play.index, 0, 'PLAY acks the start index');
});

test('PLAY 0xFFFF resumes the stored position for the durable animation', () => {
  const upload = uploadStream(frames, delays);
  // Upload, save a position, then PLAY 0xFFFF: the ack index must be the saved one.
  const replies = drive([
    ...upload.commands.map(commandLine),
    'V 2',
    commandLine(packetPlay(0xffff)),
  ]).map(parse);
  const play = replies[replies.length - 1];
  assert.equal(play.error, 0, 'PLAY 0xFFFF accepted');
  assert.equal(play.index, 2, 'PLAY 0xFFFF acks the stored position');
  assert.equal(play.flags & 0x02, 0x02, 'playback flag set');
});

test('PLAY 0xFFFF with no stored position starts at frame 0', () => {
  const upload = uploadStream(frames, delays);
  const replies = drive([
    ...upload.commands.map(commandLine),
    commandLine(packetPlay(0xffff)),
  ]).map(parse);
  const play = replies[replies.length - 1];
  assert.equal(play.error, 0, 'PLAY 0xFFFF accepted');
  assert.equal(play.index, 0, 'with no stored position the ack index is 0');
});

test('PLAY on an empty device is not found', () => {
  const replies = drive([commandLine(packetPlay(0))]).map(parse);
  assert.equal(replies[0].error, 3, 'PLAY with no stored animation is NOT_FOUND');
});

test('a truncated DATA stream is an offset error, not silent acceptance', () => {
  const frame = frames[0];
  const encoded = encodeFrame(null, frame);
  const payload = encoded.blob.subarray(8);
  const crc = animationCrc([frame]);
  const commands = [
    packetBegin(0, 1, 1, crc),
    packetFrame(0, KIND_FULL, payload.length, encoded.crc, 120),
    packetData(7, payload.subarray(7, 24)),          // wrong first offset
    packetFrameCommit(),
  ];
  const replies = drive(commands.map(commandLine)).map(parse);
  const dataReply = replies[2];
  assert.equal(dataReply.error, 8, 'a wrong first offset is error 8 (offset)');
  assert.equal(dataReply.index, 0, 'and it reports the expected offset 0');
  assert.notEqual(replies[3].error, 0, 'the frame cannot be committed');
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
