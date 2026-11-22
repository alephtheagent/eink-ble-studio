export const WIDTH = 122, HEIGHT = 250, STRIDE = 16, FRAME_BYTES = STRIDE * HEIGHT;

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Position is a native-pixel offset from center; zoom is relative to fit/cover.
// For tiles, tileSize is the tile width in native pixels and position is its phase.
export function renderGray(sourceRGBA, sw, sh, options = {}) {
  if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 || sourceRGBA.length < sw * sh * 4) throw new Error('Invalid source image');
  const { mode = 'cover', zoom = 1, x = 0, y = 0, rotation = 0, tileSize = 61 } = options;
  if (!(zoom > 0) || !Number.isFinite(zoom) || !Number.isFinite(x) || !Number.isFinite(y) || !(tileSize > 0) || !Number.isFinite(tileSize)) throw new Error('Invalid geometry');
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized % 90 !== 0) {
    const radians = normalized * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const rw = Math.abs(cos) * sw + Math.abs(sin) * sh, rh = Math.abs(sin) * sw + Math.abs(cos) * sh;
    const tiled = mode === 'tile' || mode === 'vertical';
    let scale = (mode === 'fit' ? Math.min(WIDTH / rw, HEIGHT / rh) : Math.max(WIDTH / rw, HEIGHT / rh)) * zoom;
    if (tiled) scale = (mode === 'vertical' ? Math.max(WIDTH, tileSize * zoom) : tileSize * zoom) / rw;
    const scaleX = mode === 'fill' ? WIDTH / rw * zoom : scale, scaleY = mode === 'fill' ? HEIGHT / rh * zoom : scale;
    const dw = rw * scale, left = mode === 'vertical' ? Math.max(WIDTH - dw, Math.min(0, (WIDTH - dw) / 2 + x)) : (WIDTH - rw * scaleX) / 2 + x, top = (HEIGHT - rh * scaleY) / 2 + y;
    const mod = (v, n) => ((v % n) + n) % n, gray = new Uint8Array(WIDTH * HEIGHT);
    for (let py = 0; py < HEIGHT; py++) for (let px = 0; px < WIDTH; px++) {
      let u = (px + 0.5 - left) / scaleX, v = (py + 0.5 - top) / scaleY;
      if (mode === 'tile') u = mod(u, rw); if (tiled) v = mod(v, rh);
      const dx = u - rw / 2, dy = v - rh / 2, sx = Math.floor(cos * dx + sin * dy + sw / 2), sy = Math.floor(-sin * dx + cos * dy + sh / 2);
      if (u < 0 || v < 0 || u >= rw || v >= rh || sx < 0 || sy < 0 || sx >= sw || sy >= sh) { gray[py * WIDTH + px] = 255; continue; }
      const i = (sy * sw + sx) * 4, a = sourceRGBA[i + 3] / 255;
      gray[py * WIDTH + px] = Math.round((0.299 * sourceRGBA[i] + 0.587 * sourceRGBA[i + 1] + 0.114 * sourceRGBA[i + 2]) * a + 255 * (1 - a));
    }
    return gray;
  }
  const turn = ((Math.round(rotation / 90) % 4) + 4) % 4;
  const rw = turn % 2 ? sh : sw, rh = turn % 2 ? sw : sh;
  const tiled = mode === 'tile' || mode === 'vertical';
  let scale = (mode === 'fit' ? Math.min(WIDTH / rw, HEIGHT / rh) : Math.max(WIDTH / rw, HEIGHT / rh)) * zoom;
  if (tiled) scale = (mode === 'vertical' ? Math.max(WIDTH, tileSize * zoom) : tileSize * zoom) / rw;
  const dw = rw * scale;
  const scaleX = mode === 'fill' ? WIDTH / rw * zoom : scale;
  const scaleY = mode === 'fill' ? HEIGHT / rh * zoom : scale;
  const imageWidth = rw * scaleX, imageHeight = rh * scaleY;
  const left = mode === 'vertical' ? Math.max(WIDTH - dw, Math.min(0, (WIDTH - dw) / 2 + x)) : (WIDTH - imageWidth) / 2 + x;
  const top = (HEIGHT - imageHeight) / 2 + y;
  const mod = (v, n) => ((v % n) + n) % n;
  const gray = new Uint8Array(WIDTH * HEIGHT);
  for (let py = 0; py < HEIGHT; py++) for (let px = 0; px < WIDTH; px++) {
    let u = (px + 0.5 - left) / scaleX, v = (py + 0.5 - top) / scaleY;
    if (mode === 'tile') u = mod(u, rw);
    if (tiled) v = mod(v, rh);
    if (u < 0 || v < 0 || u >= rw || v >= rh) { gray[py * WIDTH + px] = 255; continue; }
    // Nearest-neighbor sampling keeps the native pixel result deterministic.
    u = Math.floor(u); v = Math.floor(v);
    let sx, sy;
    if (turn === 1) { sx = v; sy = sh - 1 - u; }
    else if (turn === 2) { sx = sw - 1 - u; sy = sh - 1 - v; }
    else if (turn === 3) { sx = sw - 1 - v; sy = u; }
    else { sx = u; sy = v; }
    const i = (sy * sw + sx) * 4, a = sourceRGBA[i + 3] / 255;
    gray[py * WIDTH + px] = Math.round((0.299 * sourceRGBA[i] + 0.587 * sourceRGBA[i + 1] + 0.114 * sourceRGBA[i + 2]) * a + 255 * (1 - a));
  }
  return gray;
}

export function packBits(gray, width = WIDTH, height = HEIGHT, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || gray.length < width * height) throw new Error('Invalid grayscale image');
  const { threshold = 128, dither = 'none', invert = false, brightness = 0, contrast = 0 } = options;
  if (!['none', 'floyd-steinberg', 'bayer'].includes(dither)) throw new Error('Unknown dither');
  const stride = Math.ceil(width / 8), bytes = new Uint8Array(stride * height);
  const pixels = new Float32Array(width * height);
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < pixels.length; i++) {
    let value = Math.max(0, Math.min(255, factor * (gray[i] - 128) + 128 + brightness));
    pixels[i] = invert ? 255 - value : value;
  }
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, value = pixels[i];
    const limit = dither === 'bayer' ? threshold + (bayer[(y % 4) * 4 + x % 4] - 7.5) * 16 : threshold;
    const black = value < limit;
    if (black) bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    if (dither === 'floyd-steinberg') {
      const error = value - (black ? 0 : 255);
      if (x + 1 < width) pixels[i + 1] += error * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) pixels[i + width - 1] += error * 3 / 16;
        pixels[i + width] += error * 5 / 16;
        if (x + 1 < width) pixels[i + width + 1] += error / 16;
      }
    }
  }
  return bytes;
}

export function unpackBits(bytes, width = WIDTH, height = HEIGHT) {
  const stride = Math.ceil(width / 8);
  if (bytes.length < stride * height) throw new Error('Incomplete frame');
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = bytes[y * stride + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255;
  return gray;
}
