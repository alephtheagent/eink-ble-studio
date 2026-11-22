import { WIDTH, HEIGHT, STRIDE } from './image.js';

export function createPixelEditor({ preview, render, textEditor }) {
  const $ = id => document.getElementById(id), overlay = $('screen-text');
  let mode = 'image', pixels = new Int8Array(WIDTH * HEIGHT).fill(-1), history = [], drawing = false, last = null, erase = false, thickness = 1;
  function setMode(next) {
    mode = next;
    for (const name of ['image', 'text', 'draw']) $(`mode-${name}`).setAttribute('aria-pressed', String(name === mode));
    overlay.hidden = mode !== 'text'; $('direct-text-controls').hidden = mode !== 'text';
    $('screen-viewport').classList.toggle('magnified',mode==='draw' && $('draw-zoom').getAttribute('aria-pressed')==='true');
    if (mode === 'text') { sync(); overlay.focus(); }
  }
  for (const name of ['image', 'text', 'draw']) $(`mode-${name}`).onclick = () => setMode(name);
  $('side-image').onclick = () => $('open').click();
  $('side-text').onclick = () => { textEditor.add(); setMode('text'); };
  $('side-font').onclick = $('direct-font').onclick = () => {
    if (!textEditor.current()) textEditor.add({ screen: true });
    $('text-panel').hidden = false;
    $('text-panel').open = true;
    $('font-toggle').click();
    $('font-toggle').focus();
  };
  overlay.addEventListener('input', () => {
    const value = overlay.value, position = overlay.selectionStart;
    if (!textEditor.current()) {
      textEditor.add({ screen: true });
      overlay.value = value;
      overlay.focus();
      overlay.setSelectionRange(position, position);
    }
    $('text-content').value = value;
    $('text-content').dispatchEvent(new Event('input'));
  });
  function sync() {
    if (mode !== 'text') return;
    const layer = textEditor.current();
    if (overlay.value !== (layer?.content || '')) overlay.value = layer?.content || '';
    $('direct-size').value = layer?.scale || 1;
  }
  $('text-layer').addEventListener('change', sync);
  $('direct-size').addEventListener('input', e => {
    const value = e.target.value;
    if (!textEditor.current()) textEditor.add({ screen: true });
    $('text-scale').value = value;
    $('text-scale').dispatchEvent(new Event('input'));
  });
  $('draw-pencil').onclick = () => { erase = false; setMode('draw'); };
  $('draw-eraser').onclick = () => { erase = true; setMode('draw'); };
  $('draw-thickness').onclick = () => {
    thickness = thickness % 8 + 1;
    $('draw-thickness').textContent = String(thickness);
    setMode('draw');
  };
  $('draw-zoom').onclick = () => {
    const zoom = $('draw-zoom').getAttribute('aria-pressed') !== 'true';
    $('draw-zoom').setAttribute('aria-pressed', String(zoom));
    setMode('draw');
  };
  preview.addEventListener('wheel', e => { if (mode === 'draw') e.stopImmediatePropagation(); }, true);
  preview.addEventListener('keydown', e => {
    if (mode !== 'draw' || !['+', '=', '-'].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const zoom = e.key !== '-';
    $('draw-zoom').setAttribute('aria-pressed', String(zoom));
    $('screen-viewport').classList.toggle('magnified', zoom);
  }, true);
  $('draw-undo').onclick = () => { if (history.length) { pixels = history.pop(); render(); } };
  function point(e) {
    const r = preview.getBoundingClientRect();
    return [
      Math.max(0, Math.min(WIDTH - 1, Math.floor((e.clientX - r.left) * WIDTH / r.width))),
      Math.max(0, Math.min(HEIGHT - 1, Math.floor((e.clientY - r.top) * HEIGHT / r.height)))
    ];
  }
  function dot(x, y) {
    const start = -Math.floor((thickness - 1) / 2);
    for (let dy = start; dy < start + thickness; dy++) for (let dx = start; dx < start + thickness; dx++) {
      if (x + dx >= 0 && x + dx < WIDTH && y + dy >= 0 && y + dy < HEIGHT)
        pixels[(y + dy) * WIDTH + x + dx] = erase ? -1 : 1;
    }
  }
  function line(a, b) {
    let [x, y] = a, [tx, ty] = b;
    const dx = Math.abs(tx - x), sx = x < tx ? 1 : -1, dy = -Math.abs(ty - y), sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      dot(x, y);
      if (x === tx && y === ty) break;
      const e = 2 * err;
      if (e >= dy) { err += dy; x += sx; }
      if (e <= dx) { err += dx; y += sy; }
    }
  }
  preview.addEventListener('pointerdown', e => {
    if (mode !== 'draw' || e.button !== 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    drawing = true;
    history.push(pixels.slice());
    if (history.length > 100) history.shift();
    last = point(e);
    dot(...last);
    preview.setPointerCapture(e.pointerId);
    render();
  }, true);
  preview.addEventListener('pointermove', e => {
    if (!drawing) return;
    e.stopImmediatePropagation();
    const next = point(e);
    line(last, next);
    last = next;
    render();
  }, true);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) preview.addEventListener(event, e => {
    if (!drawing) return;
    e.stopImmediatePropagation();
    drawing = false;
  }, true);
  return {
    sync,
    compose(frame) {
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        if (pixels[y * WIDTH + x] < 0) continue;
        const i = y * STRIDE + (x >> 3), bit = 0x80 >> (x & 7);
        if (pixels[y * WIDTH + x]) frame[i] |= bit;
        else frame[i] &= ~bit;
      }
    },
    exportState: () => Array.from(pixels),
    importState(state) {
      pixels = state ? Int8Array.from(state) : new Int8Array(WIDTH * HEIGHT).fill(-1);
      history = [];
      sync();
    },
    mode: () => mode
  };
}
