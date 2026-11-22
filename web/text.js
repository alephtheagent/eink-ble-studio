import { FONTS } from './fonts.js';
import { WIDTH, HEIGHT, STRIDE } from './image.js';

const $ = id => document.getElementById(id);
const fields = ['content','x','y','width','height','scale','rotation','align','color','background','opacity'];
const numeric = new Set(['x','y','width','height','scale','rotation','opacity']);
const copy = state => ({ ...state, layers: state.layers.map(layer => ({ ...layer })), image: { ...state.image, values: { ...state.image.values } } });

function wrap(text, columns) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const chars = Array.from(paragraph);
    if (!chars.length) { lines.push([]); continue; }
    if (columns < 1) { lines.push(chars); continue; }
    while (chars.length > columns) {
      let end = columns;
      for (let i = columns; i > 0; i--) {
        if (/\s/u.test(chars[i])) { end = i; break; }
        if (/\s/u.test(chars[i - 1])) { end = i - 1; break; }
      }
      if (!end) end = columns;
      lines.push(chars.splice(0, end));
      while (chars.length && /\s/u.test(chars[0])) chars.shift();
    }
    if (chars.length) lines.push(chars);
  }
  return lines;
}

function bitmap(layer, warnings) {
  const font = FONTS.find(f => f.id === layer.fontId), w = layer.width, h = layer.height, scale = layer.scale;
  const pixels = new Int8Array(w * h); pixels.fill(layer.background === 'black' ? 1 : layer.background === 'white' ? 0 : -1);
  const cw = font.width * scale, ch = font.height * scale, columns = Math.floor(w / cw), lines = wrap(layer.content, columns), missing = new Set();
  if (columns < 1 && layer.content) warnings.push(`${layer.name}: text block too narrow for a glyph`);
  if (lines.length * ch > h) warnings.push(`${layer.name}: text height overflow`);
  lines.forEach((line, row) => {
    const offset = layer.align === 'right' ? w - line.length * cw : layer.align === 'center' ? Math.floor((w - line.length * cw) / 2) : 0;
    line.forEach((char, column) => {
      const glyph = font.glyphs[char]; if (!glyph) missing.add(char);
      for (let gy = 0; gy < font.height; gy++) for (let gx = 0; gx < font.width; gx++) {
        if (!(glyph ? glyph[gy]?.[gx] === '1' : gx === 0 || gy === 0 || gx === font.width - 1 || gy === font.height - 1)) continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const x = offset + column * cw + gx * scale + sx, y = row * ch + gy * scale + sy;
          if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = layer.color === 'white' ? 0 : 1;
        }
      }
    });
  });
  if (missing.size) warnings.push(`${layer.name}: missing glyphs: ${[...missing].join(' ')}`);
  return pixels;
}

export function createTextEditor({ preview, render, getImage, setImage, clearImage }) {
  let layers = [], selected = null, sequence = 0, states = [], index = -1, dragging = false, pinchScale = 1;
  const current = () => layers.find(l => l.id === selected);
  const snapshot = () => copy({ layers, selected, image: getImage() });
  function commit() { states.splice(index + 1); states.push(snapshot()); if (states.length > 100) states.shift(); index = states.length - 1; sync(); }
  function restore(i) { if (i < 0 || i >= states.length) return; index = i; const state = copy(states[index]); layers = state.layers; selected = state.selected; setImage(state.image); sync(); render(); }
  function sync() {
    $('text-undo').disabled = index <= 0; $('text-redo').disabled = index >= states.length - 1;
    $('text-panel').hidden = !layers.length; const layer = current(); $('text-properties').hidden = !layer;
    const imageOption = document.createElement('option'); imageOption.value = ''; imageOption.textContent = 'Image (bottom)';
    $('text-layer').replaceChildren(imageOption, ...[...layers].reverse().map(l => { const option = document.createElement('option'); option.value = l.id; option.textContent = l.name; return option; }));
    $('text-layer').value = selected || '';
    for (const id of ['text-up','text-down','text-delete']) $(id).disabled = !layer;
    if (!layer) return;
    for (const field of fields) $(defaultId(field)).value = layer[field];
    $('text-opacity-value').textContent = `${layer.opacity}%`;
    const font = FONTS.find(f => f.id === layer.fontId); $('font-toggle').textContent = `${font.name} · ${font.width}×${font.height} px ▾`;
    for (const button of $('font-list').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.font === layer.fontId));
  }
  const defaultId = field => `text-${field}`;
  function add() { const n = ++sequence; layers.push({ id: `text-${n}`, name: `Text ${n}`, content: 'Привет, мир!', fontId: FONTS[0].id, x: 0, y: 0, width: WIDTH, height: 52, scale: 1, rotation: 0, align: 'left', color: 'black', background: 'transparent', opacity: 100 }); selected = layers.at(-1).id; $('text-panel').open = true; commit(); render(); $('text-content').focus(); }
  $('add-text').onclick = add;
  $('toolbar-add-text').onclick = add;
  $('text-only').onclick = () => { clearImage(); layers = []; selected = null; add(); };
  $('text-layer').onchange = () => { selected = $('text-layer').value; sync(); };
  $('text-image').onclick = () => { selected = null; sync(); preview.focus(); };
  $('text-delete').onclick = () => { layers = layers.filter(l => l.id !== selected); selected = layers.at(-1)?.id || null; commit(); render(); };
  for (const [id, delta] of [['text-up', 1], ['text-down', -1]]) $(id).onclick = () => { const i = layers.findIndex(l => l.id === selected), j = i + delta; if (i < 0 || j < 0 || j >= layers.length) return; [layers[i], layers[j]] = [layers[j], layers[i]]; commit(); render(); };
  $('text-undo').onclick = () => restore(index - 1); $('text-redo').onclick = () => restore(index + 1);
  for (const field of fields) $(defaultId(field)).addEventListener('input', e => { const layer = current(); if (!layer) return; let value = e.target.value; if (numeric.has(field)) { if (value === '' || !Number.isFinite(Number(value))) return; value = Number(value); if (['width','height'].includes(field)) value = Math.max(1, Math.min(500, Math.floor(value))); if (field === 'scale') value = Math.max(1, Math.min(20, Math.floor(value))); } layer[field] = value; commit(); render(); });
  let lastHeight = 0;
  for (const font of [...FONTS].sort((a,b) => a.height-b.height)) {
    if (font.height !== lastHeight) { const heading = document.createElement('strong'); heading.textContent = `${font.height} px native height`; $('font-list').append(heading); lastHeight = font.height; }
    const button = document.createElement('button'), canvas = document.createElement('canvas'), label = font.name;
    button.type = 'button'; button.dataset.font = font.id; button.setAttribute('aria-label', `${font.name}, ${font.width} by ${font.height} pixels`);
    canvas.width = Array.from(label).length * font.width; canvas.height = font.height; canvas.setAttribute('aria-hidden','true');
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle = '#000';
    Array.from(label).forEach((char,i) => font.glyphs[char]?.forEach((row,y) => Array.from(row).forEach((bit,x) => { if (bit === '1') ctx.fillRect(i*font.width+x,y,1,1); })));
    const size = document.createElement('small'); size.textContent = `${font.width}×${font.height} px`; button.append(canvas,size); button.onclick = () => { if (!current()) return; current().fontId = font.id; $('font-list').hidden = true; $('font-toggle').setAttribute('aria-expanded','false'); commit(); render(); $('font-toggle').focus(); }; $('font-list').append(button);
  }
  $('font-toggle').onclick = () => { const open = $('font-list').hidden; $('font-list').hidden = !open; $('font-toggle').setAttribute('aria-expanded', String(open)); };
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT','TEXTAREA'].includes(e.target.tagName)) { e.preventDefault(); restore(index + (e.shiftKey ? 1 : -1)); } });
  commit();
  return {
    checkpoint: commit,
    selected: () => !!current(),
    move(dx,dy) { const layer = current(); if (!layer) return false; layer.x = Math.round((layer.x + dx)*100)/100; layer.y = Math.round((layer.y + dy)*100)/100; sync(); render(); return true; },
    resize(factor, continuous = false) { const layer = current(); if (!layer) return false; if (factor === 1) return true; let steps = factor > 1 ? 1 : -1; if (continuous) { pinchScale *= factor; steps = 0; while (pinchScale >= 1.1) { steps++; pinchScale /= 1.1; } while (pinchScale <= 1 / 1.1) { steps--; pinchScale *= 1.1; } } if (steps) { layer.scale = Math.max(1, Math.min(20, layer.scale + steps)); sync(); render(); } return true; },
    beginDrag() { dragging = !!current(); pinchScale = 1; }, endDrag() { if (dragging) { dragging = false; commit(); } pinchScale = 1; },
    compose(frame) {
      const warnings = [];
      for (const layer of layers) {
        const w = layer.width, h = layer.height, pixels = bitmap(layer, warnings), angle = layer.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), cx = layer.x + w / 2, cy = layer.y + h / 2, hw = (Math.abs(cos)*w + Math.abs(sin)*h)/2, hh = (Math.abs(sin)*w + Math.abs(cos)*h)/2;
        if (cx-hw < -1e-9 || cy-hh < -1e-9 || cx+hw > WIDTH+1e-9 || cy+hh > HEIGHT+1e-9) warnings.push(`${layer.name}: layer clipped by canvas`);
        for (let y = Math.max(0, Math.floor(cy-hh)); y < Math.min(HEIGHT, Math.ceil(cy+hh)); y++) for (let x = Math.max(0, Math.floor(cx-hw)); x < Math.min(WIDTH, Math.ceil(cx+hw)); x++) {
          const dx = x+0.5-cx, dy = y+0.5-cy, u = cos*dx+sin*dy+w/2, v = -sin*dx+cos*dy+h/2;
          if (u < 0 || v < 0 || u >= w || v >= h) continue;
          const value = pixels[Math.floor(v)*w+Math.floor(u)]; if (value < 0) continue;
          // Binary spatial coverage: opacity never introduces gray or photo dithering.
          if (layer.opacity < 100 && (((x * 73 + y * 151 + x * y * 19) % 100) >= layer.opacity)) continue;
          const i = y*STRIDE+(x>>3), mask = 0x80>>(x&7); if (value) frame[i] |= mask; else frame[i] &= ~mask;
        }
      }
      $('text-warnings').textContent = warnings.join(' · ');
    }
  };
}
