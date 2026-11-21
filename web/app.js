import { WIDTH, HEIGHT, FRAME_BYTES, renderGray, packBits, unpackBits } from './image.js';
import { BleTransport } from './ble.js';
const $ = id => document.getElementById(id);
const preview = $('preview'), native = $('native'), status = $('status');
let source = null, rotation = 0, frame = new Uint8Array(FRAME_BYTES), connected = false, sending = false;
const number = (id, fallback) => { const n = Number($(id).value); return $(id).value !== '' && Number.isFinite(n) ? n : fallback; };
const geometry = () => ({ mode: $('mode').value, zoom: Math.max(0.1, number('zoom', 1)), x: number('x', 0), y: number('y', 0), tileSize: Math.max(1, number('tileSize', 61)), rotation });
function render() {
  const gray = source ? renderGray(source.data, source.width, source.height, geometry()) : new Uint8Array(WIDTH * HEIGHT).fill(255);
  frame = packBits(gray, WIDTH, HEIGHT, { threshold: number('threshold', 128), brightness: number('brightness', 0), contrast: number('contrast', 0), dither: $('dither').value, invert: $('invert').checked });
  const pixels = unpackBits(frame), ctx = native.getContext('2d'), image = ctx.createImageData(WIDTH, HEIGHT);
  for (let i = 0; i < pixels.length; i++) { const j = i * 4; image.data[j] = image.data[j + 1] = image.data[j + 2] = pixels[i]; image.data[j + 3] = 255; }
  ctx.putImageData(image, 0, 0); preview.getContext('2d').putImageData(image, 0, 0);
}
for (const id of ['mode', 'zoom', 'x', 'y', 'tileSize', 'brightness', 'contrast', 'threshold', 'dither', 'invert']) $(id).addEventListener('input', () => { if ($(`${id}-value`)) $(`${id}-value`).textContent = $(id).value; render(); });
$('open').addEventListener('click', () => $('file').click());
async function loadImage(url, name, reference = false) {
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); source = ctx.getImageData(0, 0, canvas.width, canvas.height);
  $('image-name').textContent = name; rotation = 0; $('x').value = $('y').value = 0; $('zoom').value = 1;
  if (reference) {
    $('mode').value = 'cover'; $('dither').value = 'none'; $('threshold').value = 128;
    $('brightness').value = $('contrast').value = 0; $('invert').checked = false;
    for (const id of ['threshold', 'brightness', 'contrast']) $(`${id}-value`).textContent = $(id).value;
  }
  render();
}
$('reference').addEventListener('click', async () => {
  try { await loadImage('reference.png', 'Approved native reference', true); }
  catch (e) { status.textContent = `Could not open reference: ${e.message}`; }
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  const target = $(button.dataset.action);
  if (target.id === 'invert') { target.checked = !target.checked; target.dispatchEvent(new Event('input')); }
  else if (!target.disabled) target.click();
  button.closest('details').open = false;
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelectorAll('details[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
});
$('file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    await loadImage(url, file.name);
  } catch (e) { status.textContent = `Could not open image: ${e.message}`; }
  finally { URL.revokeObjectURL(url); event.target.value = ''; }
});
$('reset').addEventListener('click', () => { rotation = 0; $('x').value = $('y').value = 0; $('zoom').value = 1; render(); });
$('rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; render(); });
function move(dx, dy) { $('x').value = Math.round((number('x', 0) + dx) * 100) / 100; $('y').value = Math.round((number('y', 0) + dy) * 100) / 100; render(); }
const pointers = new Map();
function pointerDistance() { const [a, b] = [...pointers.values()]; return b ? Math.hypot(b.x - a.x, b.y - a.y) : 0; }
preview.addEventListener('pointerdown', e => { if (e.button !== 0) return; preview.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); e.preventDefault(); });
preview.addEventListener('pointermove', e => {
  const previous = pointers.get(e.pointerId); if (!previous) return;
  const oldDistance = pointerDistance();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size > 1) { const distance = pointerDistance(); if (oldDistance > 0 && distance > 0) zoomBy(distance / oldDistance); }
  else { const rect = preview.getBoundingClientRect(); move((e.clientX - previous.x) * WIDTH / rect.width, (e.clientY - previous.y) * HEIGHT / rect.height); }
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) preview.addEventListener(event, e => pointers.delete(e.pointerId));
preview.addEventListener('keydown', e => { const step = e.shiftKey ? 10 : 1, directions = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }; if (directions[e.key]) { e.preventDefault(); move(...directions[e.key]); } });
function zoomBy(factor) { $('zoom').value = Math.max(0.1, Math.min(10, number('zoom', 1) * factor)).toFixed(2); render(); }
preview.addEventListener('keydown', e => { if (['+', '=', '-'].includes(e.key)) { e.preventDefault(); zoomBy(e.key === '-' ? 1 / 1.1 : 1.1); } });
preview.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
function download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('png').addEventListener('click', () => native.toBlob(blob => { if (blob) download(blob, 'eink-122x250.png'); else status.textContent = 'Could not create PNG.'; }, 'image/png'));
$('frame').addEventListener('click', () => download(new Blob([frame], { type: 'application/octet-stream' }), 'eink-122x250.bin'));
function buttons() { $('connect').disabled = connected || sending || !navigator.bluetooth; $('send').disabled = !connected || sending; $('disconnect').disabled = !connected || sending; }
const transport = new BleTransport({ onProgress: (n, total) => { $('progress').max = total; $('progress').value = n; status.textContent = `Sending: ${n} / ${total} bytes acknowledged.`; }, onStatus: s => { if (s.disconnected) { connected = false; status.textContent = 'Disconnected. Reconnect to start a new transfer.'; buttons(); } else if (s.state === 2 || s.state === 3) status.textContent = 'Frame accepted; display is refreshing…'; } });
$('connect').addEventListener('click', async () => { sending = true; buttons(); try { const s = await transport.connect(); connected = true; status.textContent = `Connected. Device state: ${['idle', 'receiving', 'queued', 'refreshing', 'done', 'error'][s.state] || 'unknown'}.`; } catch (e) { transport.disconnect(); status.textContent = `Connection failed: ${e.message}`; } finally { sending = false; buttons(); } });
$('disconnect').addEventListener('click', () => { transport.disconnect(); connected = false; status.textContent = 'Disconnected.'; buttons(); });
$('send').addEventListener('click', async () => { sending = true; $('progress').value = 0; buttons(); try { await transport.send(frame.slice()); status.textContent = 'Display refresh completed.'; } catch (e) { status.textContent = `Transfer failed: ${e.message}`; if (!transport.command) connected = false; } finally { sending = false; buttons(); } });
if (!navigator.bluetooth) status.textContent = 'Web Bluetooth unavailable. Use supported Chromium on HTTPS or localhost; iOS Safari is not supported.';
buttons(); render();
