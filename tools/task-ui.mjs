// Interactive browser checks; no radio or physical display is exercised.
import { chromium, firefox } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const root = resolve('web');
const output = resolve('artifacts/task-verification');
await mkdir(output, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.bdf': 'text/plain' };
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await (process.env.TASK_BROWSER === 'firefox' ? firefox : chromium).launch({ headless: true, ...(process.env.TASK_BROWSER_PATH ? { executablePath: process.env.TASK_BROWSER_PATH } : {}) });
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', acceptDownloads: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.screenshot({ path: `${output}/ui-${width}-initial.png`, fullPage: true });
    const white = createCanvas(122, 250); const whiteCtx = white.getContext('2d');
    whiteCtx.fillStyle = 'white'; whiteCtx.fillRect(0, 0, 122, 250);
    await page.locator('#file').setInputFiles({name:'white.png',mimeType:'image/png',buffer:white.toBuffer('image/png')});
    await page.waitForFunction(() => document.querySelector('#image-name').textContent === 'white.png');
    const imageOnly = await page.locator('#native').evaluate(c => c.toDataURL());
    await page.locator('#mode-text').click();
    await page.locator('#screen-text').fill('Test text\nSecond line');
    assert.notEqual(await page.locator('#native').evaluate(c => c.toDataURL()), imageOnly, 'text input changes the rendered native frame');
    await page.locator('#mode-draw').click();
    const canvas = page.locator('#preview');
    const before = await canvas.evaluate(c => c.toDataURL());
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7, { steps: 8 }); await page.mouse.up();
    assert.notEqual(await canvas.evaluate(c => c.toDataURL()), before, 'drawing changes preview');
    await page.locator('#draw-undo').click();
    assert.equal(await canvas.evaluate(c => c.toDataURL()), before, 'undo restores pixels');
    await page.locator('#draw-thickness').click();
    const nextBox = await canvas.boundingBox();
    await page.mouse.move(nextBox.x + nextBox.width * .4, nextBox.y + nextBox.height * .4);
    await page.mouse.down(); await page.mouse.up();
    const dot = await canvas.evaluate(c => c.toDataURL());
    assert.notEqual(dot, before);
    await page.locator('#draw-eraser').click();
    const eraseBox = await canvas.boundingBox();
    await page.mouse.move(eraseBox.x + eraseBox.width * .4, eraseBox.y + eraseBox.height * .4);
    await page.mouse.down(); await page.mouse.up();
    assert.equal(await canvas.evaluate(c => c.toDataURL()), before, 'eraser restores underlying pixels');
    const normalWidth = (await canvas.boundingBox()).width;
    await page.locator('#draw-zoom').click();
    assert.ok((await canvas.boundingBox()).width > normalWidth, 'draw zoom magnifies the native canvas');
    assert.equal(await page.locator('#draw-zoom').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'zoom must not overflow viewport');
    await page.locator('#draw-pencil').click();
    await canvas.scrollIntoViewIfNeeded();
    const zoomCanvas = await canvas.boundingBox(), viewport = await page.locator('#screen-viewport').boundingBox();
    const px = Math.max(zoomCanvas.x, viewport.x) + 25, py = Math.max(zoomCanvas.y, viewport.y) + 25;
    const nativeX = Math.floor((px - zoomCanvas.x) * 122 / zoomCanvas.width);
    const nativeY = Math.floor((py - zoomCanvas.y) * 250 / zoomCanvas.height);
    await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.up();
    await page.screenshot({ path: `${output}/ui-${width}-magnified.png`, fullPage: true });
    await page.locator('#draw-zoom').click();
    const editedFrame = await page.locator('#native').evaluate(c => c.toDataURL());
    await page.screenshot({ path: `${output}/ui-${width}-edited.png`, fullPage: true });
    const count = () => page.locator('#page-list button').count();
    const originalCount = await count();
    await page.locator('#page-new').click();
    assert.equal(await count(), originalCount + 1);
    const download = page.waitForEvent('download');
    await page.locator('#project-export').click();
    const project = await (await download).path();
    const exported = JSON.parse(await readFile(project, 'utf8'));
    assert.ok(exported.pages[0].state.image.source, 'image source survives project export');
    assert.ok(exported.pages[0].state.text.layers.some(layer => layer.content === 'Test text\nSecond line'));
    assert.equal(exported.pages[0].state.drawing[nativeY * 122 + nativeX], 1, 'magnified pointer hits expected native pixel');
    await page.locator('#page-new').click();
    await page.locator('#project-file').setInputFiles(project);
    await page.waitForFunction(expected => document.querySelectorAll('#page-list button').length === expected, originalCount + 1);
    await page.locator('#page-list button').first().click();
    assert.equal(await page.locator('#native').evaluate(c => c.toDataURL()), editedFrame, 'project import restores exact native frame');
    await page.locator('#mode-text').click();
    assert.equal(await page.locator('#screen-text').inputValue(), 'Test text\nSecond line');
    const black = createCanvas(122,250); black.getContext('2d').fillRect(0,0,122,250);
    await page.locator('#batch-files').setInputFiles([{name:'white.png',mimeType:'image/png',buffer:white.toBuffer('image/png')},{name:'black.png',mimeType:'image/png',buffer:black.toBuffer('image/png')}]);
    await page.locator('#batch-mode').selectOption('cover');
    await page.locator('#batch-rotation').selectOption('90');
    await page.locator('#batch-dither').selectOption('bayer');
    await page.waitForFunction(() => document.querySelectorAll('#batch-preview canvas').length === 2);
    const previews = await page.locator('#batch-preview canvas').evaluateAll(nodes => nodes.map(c => c.toDataURL()));
    assert.notEqual(previews[0], previews[1], 'batch contains distinct source images');
    await page.locator('#batch-apply').click();
    await page.waitForFunction(expected => document.querySelectorAll('#page-list button').length === expected, originalCount + 3);
    const imported = await page.locator('#page-list button canvas').evaluateAll(nodes => nodes.slice(-2).map(c => c.toDataURL()));
    assert.deepEqual(imported, previews, 'both imported frames match their batch previews');
    const englishStatus = await page.locator('#pages-status').textContent();
    assert.ok(englishStatus.trim());
    await page.locator('#language-select').selectOption('ru');
    assert.notEqual(await page.locator('#pages-status').textContent(), englishStatus, 'existing page status updates on language switch');
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    await page.reload();
    assert.equal(await page.locator('#language-select').inputValue(), 'ru');
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, JSON.stringify(dimensions));
    for (const id of ['mode-image', 'mode-text', 'mode-draw', 'draw-pencil', 'draw-eraser', 'language-select']) {
      const element = page.locator('#' + id);
      assert.ok(await element.isVisible(), id);
      assert.ok(await element.evaluate(e => (e.getAttribute('aria-label') || e.textContent || e.labels?.[0]?.textContent || '').trim()), id + ' accessible name');
    }
    await page.screenshot({ path: `${output}/ui-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS viewport ${width}: interactive text/draw, project, batch, language persistence, overflow and labels`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
