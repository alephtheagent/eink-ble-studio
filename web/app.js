import { WIDTH, HEIGHT, FRAME_BYTES, renderGray, packBits, unpackBits } from './image.js';
import { BleTransport } from './ble.js';
import { createTextEditor } from './text.js';
import { initOta } from './ota.js';
import { createPixelEditor } from './editor.js';
import { createPages } from './pages.js';
import { t, subscribeLanguage, initI18n } from './i18n.js';
const $ = id => document.getElementById(id);
let statusKey = 'device.notConnected', statusVars = {};
function setStatus(key, vars = {}) { statusKey=key; statusVars=vars; status.textContent=t(key,key==='device.connected' ? {...vars,state:t(vars.state)} : vars); }
const preview = $('preview'), native = $('native'), status = $('status');
subscribeLanguage(() => setStatus(statusKey,statusVars));
let source = null, rotation = 0, frame = new Uint8Array(FRAME_BYTES), connected = false, sending = false;
let textEditor, pixelEditor, pages, whiteBackground = false, ota = null;
subscribeLanguage(() => { if (!source) $('image-name').textContent=t('image.noneSelected'); });
const imageFields = ['mode', 'zoom', 'x', 'y', 'tileSize', 'brightness', 'contrast', 'threshold', 'dither', 'invert'];
function imageState() { return { source, rotation, whiteBackground, values: Object.fromEntries(imageFields.map(id => [id, id === 'invert' ? $(id).checked : $(id).value])) }; }
function restoreImage(state) { source = state.source; rotation = state.rotation; whiteBackground = state.whiteBackground; $('image-rotation').value = rotation; for (const [id, value] of Object.entries(state.values)) { if (id === 'invert') $(id).checked = value; else $(id).value = value; if ($(`${id}-value`)) $(`${id}-value`).textContent = value; } $('image-name').textContent = source ? (state.name || t('panel.image')) : t('image.noneSelected'); }
const number = (id, fallback) => { const n = Number($(id).value); return $(id).value !== '' && Number.isFinite(n) ? n : fallback; };
const geometry = () => ({ mode: $('mode').value, zoom: Math.max(0.1, number('zoom', 1)), x: number('x', 0), y: number('y', 0), tileSize: Math.max(1, number('tileSize', 61)), rotation });
function render() {
  const gray = source ? renderGray(source.data, source.width, source.height, geometry()) : new Uint8Array(WIDTH * HEIGHT).fill(255);
  frame = whiteBackground && !source ? new Uint8Array(FRAME_BYTES) : packBits(gray, WIDTH, HEIGHT, { threshold: number('threshold', 128), brightness: number('brightness', 0), contrast: number('contrast', 0), dither: $('dither').value, invert: $('invert').checked });
  if (textEditor) textEditor.compose(frame);
  pixelEditor?.sync();
  if (pixelEditor) pixelEditor.compose(frame);
  const pixels = unpackBits(frame), ctx = native.getContext('2d'), image = ctx.createImageData(WIDTH, HEIGHT);
  for (let i = 0; i < pixels.length; i++) { const j = i * 4; image.data[j] = image.data[j + 1] = image.data[j + 2] = pixels[i]; image.data[j + 3] = 255; }
  ctx.putImageData(image, 0, 0); preview.getContext('2d').putImageData(image, 0, 0);
  pages?.refresh();
}
for (const id of imageFields) $(id).addEventListener('input', () => { if ($(`${id}-value`)) $(`${id}-value`).textContent = $(id).value; render(); textEditor.checkpoint(); });
$('open').addEventListener('click', () => $('file').click());
async function loadImage(url, name, reference = false) {
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); source = ctx.getImageData(0, 0, canvas.width, canvas.height);
  whiteBackground = false;
  $('image-name').textContent = name; rotation = 0; $('x').value = $('y').value = 0; $('zoom').value = 1;
  if (reference) {
    $('mode').value = 'cover'; $('dither').value = 'none'; $('threshold').value = 128;
    $('brightness').value = $('contrast').value = 0; $('invert').checked = false;
    for (const id of ['threshold', 'brightness', 'contrast']) $(`${id}-value`).textContent = $(id).value;
  }
  $('image-rotation').value = rotation;
  render();
  textEditor.checkpoint();
}
$('reference').addEventListener('click', async () => {
  try { await loadImage('data:image/png;base64,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', 'Approved native reference', true); }
  catch (e) { setStatus('error.openReference',{error:e.message}); }
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.action === 'firmware') { openFirmware(); button.closest('details').open = false; return; }
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
  } catch (e) { setStatus('error.openImage',{error:e.message}); }
  finally { URL.revokeObjectURL(url); event.target.value = ''; }
});
$('reset').addEventListener('click', () => { rotation = 0; $('image-rotation').value = 0; $('x').value = $('y').value = 0; $('zoom').value = 1; render(); textEditor.checkpoint(); });
$('rotate').addEventListener('click', () => { rotation = (rotation + 90) % 360; $('image-rotation').value = rotation; render(); textEditor.checkpoint(); });
$('image-fine').addEventListener('click', () => { $('image-fine-panel').hidden = false; $('image-fine-panel').open = true; $('image-rotation').focus(); });
$('image-rotation').addEventListener('input', () => { if ($('image-rotation').value === '' || !Number.isFinite(Number($('image-rotation').value))) return; rotation = Number($('image-rotation').value); render(); textEditor.checkpoint(); });
function move(dx, dy) { $('x').value = Math.round((number('x', 0) + dx) * 100) / 100; $('y').value = Math.round((number('y', 0) + dy) * 100) / 100; render(); }
const pointers = new Map();
function pointerDistance() { const [a, b] = [...pointers.values()]; return b ? Math.hypot(b.x - a.x, b.y - a.y) : 0; }
preview.addEventListener('pointerdown', e => { if (e.button !== 0) return; preview.setPointerCapture(e.pointerId); if (!pointers.size) textEditor.beginDrag(); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); e.preventDefault(); });
preview.addEventListener('pointermove', e => {
  const previous = pointers.get(e.pointerId); if (!previous) return;
  const oldDistance = pointerDistance();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size > 1) { const distance = pointerDistance(); if (oldDistance > 0 && distance > 0) { if (!textEditor.resize(distance / oldDistance, true)) zoomBy(distance / oldDistance); } }
  else { const rect = preview.getBoundingClientRect(), dx = (e.clientX - previous.x) * WIDTH / rect.width, dy = (e.clientY - previous.y) * HEIGHT / rect.height; if (!textEditor.move(dx, dy)) move(dx, dy); }
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) preview.addEventListener(event, e => { if (!pointers.delete(e.pointerId)) return; if (!pointers.size) { if (textEditor.selected()) textEditor.endDrag(); else textEditor.checkpoint(); } });
preview.addEventListener('keydown', e => { const step = e.shiftKey ? 10 : 1, directions = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }; if (directions[e.key]) { e.preventDefault(); if (!textEditor.move(...directions[e.key])) move(...directions[e.key]); textEditor.checkpoint(); } });
function zoomBy(factor) { $('zoom').value = Math.max(0.1, Math.min(10, number('zoom', 1) * factor)).toFixed(2); render(); }
preview.addEventListener('keydown', e => { if (['+', '=', '-'].includes(e.key)) { e.preventDefault(); const factor = e.key === '-' ? 1 / 1.1 : 1.1; if (!textEditor.resize(factor)) zoomBy(factor); textEditor.checkpoint(); } });
preview.addEventListener('wheel', e => { e.preventDefault(); const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1; if (!textEditor.resize(factor)) zoomBy(factor); textEditor.checkpoint(); }, { passive: false });
function download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('png').addEventListener('click', () => native.toBlob(blob => { if (blob) download(blob, 'eink-122x250.png'); else setStatus('error.createPng'); }, 'image/png'));
$('frame').addEventListener('click', () => download(new Blob([frame], { type: 'application/octet-stream' }), 'eink-122x250.bin'));
function buttons() { $('connect').disabled = connected || sending || !navigator.bluetooth; $('send').disabled = !connected || sending; $('disconnect').disabled = !connected || sending; ota?.setConnected(connected); }
function openFirmware() { const panel = $('firmware'); if (!panel) return; panel.hidden = false; panel.open = true; panel.scrollIntoView?.({ block: 'nearest' }); }
const transport = new BleTransport({ onProgress: (n, total) => { $('progress').max = total; $('progress').value = n; setStatus('device.sending',{sent:n,total}); }, onStatus: s => { if (s.disconnected) { connected = false; setStatus('device.disconnectedReconnect'); buttons(); } else if (s.state === 2 || s.state === 3) setStatus('device.acceptedRefreshing'); } });
$('connect').addEventListener('click', async () => { sending = true; buttons(); try { const s = await transport.connect(); connected = true; setStatus('device.connected',{state:['device.stateIdle','device.stateReceiving','device.stateQueued','device.stateRefreshing','device.stateDone','device.stateError'][s.state] || 'device.stateUnknown'}); } catch (e) { transport.disconnect(); setStatus('device.connectionFailed',{error:e.message}); } finally { sending = false; buttons(); } });
$('disconnect').addEventListener('click', () => { transport.disconnect(); connected = false; setStatus('device.disconnected'); buttons(); });
$('send').addEventListener('click', async () => { sending = true; $('progress').value = 0; buttons(); try { await transport.send(frame.slice()); setStatus('device.refreshCompleted'); } catch (e) { setStatus('device.transferFailed',{error:e.message}); if (!transport.command) connected = false; } finally { sending = false; buttons(); } });
if (!navigator.bluetooth) setStatus('device.bluetoothUnavailable');
ota = initOta({ transport });
$('fw-open').addEventListener('click', openFirmware);
textEditor = createTextEditor({ preview, render, getImage: () => ({ ...imageState(), name: $('image-name').textContent }), setImage: restoreImage, clearImage: () => { source = null; whiteBackground = true; $('image-name').textContent = t('image.noneSelected'); } });
pixelEditor = createPixelEditor({ preview, render, textEditor });
pages = createPages({ transport, render, getFrame: () => frame.slice(), capture: () => ({ image: { ...imageState(), name: $('image-name').textContent, source: source ? { width: source.width, height: source.height, data: Array.from(source.data) } : null }, text: textEditor.exportState(), drawing: pixelEditor.exportState() }), restore: state => { const image = state.image; restoreImage({ ...image, source: image.source ? new ImageData(Uint8ClampedArray.from(image.source.data), image.source.width, image.source.height) : null }); textEditor.importState(state.text); pixelEditor.importState(state.drawing); render(); } });
initI18n({ selector: '#language-select' });
buttons(); render();
