// Reproduce byte sizes only: no RF/throughput or physical display measurement.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, relative } from 'node:path';
import assert from 'node:assert/strict';
import { renderGray, packBits, crc32 } from '../web/image.js';
import { chooseCodec, encodePackBits } from '../web/ble.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'artifacts/v2-measurements');
await mkdir(out, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
const canvas = createCanvas(244, 500), ctx = canvas.getContext('2d');
ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 244, 500);
ctx.fillStyle = 'black'; ctx.fillRect(12, 12, 220, 6);
for (let y = 50; y < 230; y += 30) { ctx.fillStyle = '#aaa'; ctx.fillRect(12, y, 220, 1); }
ctx.strokeStyle = 'black'; ctx.lineWidth = 3; ctx.beginPath();
for (let x = 12; x < 232; x++) { const y = 135 + Math.sin(x / 21) * 55; if (x === 12) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
ctx.stroke();
for (let x = 12; x < 232; x++) { const v = Math.round((x - 12) * 255 / 219); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 270, 1, 120); }
ctx.fillStyle = 'black'; ctx.fillRect(12, 430, 90, 45); ctx.strokeRect(140, 430, 90, 45);
const graphPath = resolve(out, 'generated-graph.png');
await writeFile(graphPath, canvas.toBuffer('image/png'));
const rows = [];
for (const [name, path] of [['approved-avatar', 'tests/fixtures/approved-native.png'], ['approved-welcome', 'assets/approved-welcome.png'], ['generated-graph', relative(root, graphPath)]]) {
  const source = await readFile(resolve(root, path));
  const image = await loadImage(source);
  const c = createCanvas(image.width, image.height), cx = c.getContext('2d');
  cx.drawImage(image, 0, 0);
  const gray = renderGray(cx.getImageData(0, 0, image.width, image.height).data, image.width, image.height);
  for (const dither of ['none', 'bayer', 'floyd-steinberg']) {
    const frame = packBits(gray, 122, 250, { dither });
    if (name === 'approved-avatar' && dither === 'none') assert.deepEqual(Buffer.from(frame), await readFile(resolve(root, 'tests/fixtures/approved-frame.bin')));
    const encoded = encodePackBits(frame), selected = chooseCodec(frame);
    const stem = `${name}-${dither}`;
    await writeFile(resolve(out, `${stem}.bin`), frame);
    await writeFile(resolve(out, `${stem}.wire`), selected.bytes);
    rows.push({ name, dither, source: path, sourceSHA256: sha(source), rawBytes: frame.length, packBitsBytes: encoded.length, codec: selected.codec, wireBytes: selected.bytes.length, rawSHA256: sha(frame), crc32: crc32(frame).toString(16).padStart(8, '0'), writes: Object.fromEntries([20, 125, 244].map(ceiling => [ceiling, Math.ceil(selected.bytes.length / (ceiling - 7)) + 2])) });
  }
}
const literal = Uint8Array.from({ length: 4000 }, (_, i) => i & 255);
assert.equal(encodePackBits(literal).length, 4032);
assert.equal(chooseCodec(literal).codec, 0);
const result = { scope: 'Actual JS image pipeline and codec byte measurements; writes include START and COMMIT, exclude capabilities and refresh polling. No RF timings.', literalWorstCase: { raw: 4000, packBits: 4032, selected: 4000 }, rows };
await writeFile(resolve(out, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
