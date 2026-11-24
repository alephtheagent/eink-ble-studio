// Real-browser smoke for the animation panel: import tests/fixtures/animation/sample.gif
// through the ordinary file input, check the stats panel, the 320 px first screen
// and the Russian locale, then capture screenshots.
//
//   node tools/anim-ui-smoke.mjs
//
// Playwright here may only have a partially installed chromium; the script tries
// chromium first, then falls back to an installed Firefox build and records which
// engine produced the artifacts. It never downloads browsers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const ARTIFACTS = resolve(ROOT, 'artifacts');
const FIXTURE = resolve(ROOT, 'tests/fixtures/animation/sample.gif');
const LOG = resolve(ARTIFACTS, 'anim-ui-smoke.log');
await mkdir(ARTIFACTS, { recursive: true });

const log = [];
const note = (...parts) => { const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' '); log.push(line); console.log(line); };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.bdf': 'text/plain; charset=utf-8', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(WEB, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(WEB + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const URL_BASE = `http://127.0.0.1:${server.address().port}/`;
note(`serving ${WEB} at ${URL_BASE}`);

async function launch() {
  const wanted = process.env.ANIM_SMOKE_BROWSER;
  if (wanted === 'firefox') return { browser: await firefox.launch({ headless: true, ...(process.env.ANIM_SMOKE_BROWSER_PATH ? { executablePath: process.env.ANIM_SMOKE_BROWSER_PATH } : {}) }), engine: 'firefox' };
  if (wanted === 'chromium') return { browser: await chromium.launch({ headless: true, ...(process.env.ANIM_SMOKE_BROWSER_PATH ? { executablePath: process.env.ANIM_SMOKE_BROWSER_PATH } : {}) }), engine: 'chromium' };
  try {
    const browser = await chromium.launch({ headless: true });
    return { browser, engine: 'chromium' };
  } catch (error) {
    note(`chromium unavailable (${String(error.message).split('\n')[0]}); trying an installed Firefox`);
  }
  const cached = join(process.env.HOME || '', '.cache/ms-playwright');
  const candidates = existsSync(cached)
    ? (await readdir(cached)).filter(name => name.startsWith('firefox-')).sort().reverse()
      .map(name => join(cached, name, 'firefox/firefox')).filter(path => existsSync(path))
    : [];
  for (const executablePath of candidates) {
    try {
      const browser = await firefox.launch({ headless: true, executablePath });
      return { browser, engine: `firefox (${executablePath})` };
    } catch (error) { note(`firefox at ${executablePath} failed: ${String(error.message).split('\n')[0]}`); }
  }
  throw new Error('No usable Playwright browser; install one with npx playwright install firefox');
}

const { browser, engine } = await launch();
note(`engine: ${engine}`);
const shots = [];
const results = [];
try {
  for (const [name, width, height] of [['mobile-320', 320, 740], ['mobile-390', 390, 844], ['desktop', 1280, 900]]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [], consoleErrors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', request => requests.push(request.url()));
    await page.goto(URL_BASE);
    await page.waitForFunction(() => document.querySelector('#anim-status')?.textContent?.length > 0);

    // The first screen must still be the editor: connect button, image panel,
    // no horizontal overflow, animation panel below the fold.
    const first = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
      connectVisible: !!document.querySelector('#connect')?.getBoundingClientRect().width,
      connectDisabled: document.querySelector('#connect')?.disabled,
      imagePanel: !!document.querySelector('#preview')?.getBoundingClientRect().width,
      imageTitle: document.querySelector('#preview-title')?.textContent?.trim(),
      animTitle: document.querySelector('#anim-title')?.textContent?.trim(),
      animTop: document.querySelector('.anim-window')?.getBoundingClientRect().top,
      imageTop: document.querySelector('.preview-window')?.getBoundingClientRect().top
    }));
    assert.ok(first.scroll <= first.width, `horizontal overflow at ${width}px: ${JSON.stringify(first)}`);
    assert.equal(first.connectVisible, true, `connect button must be on the first screen at ${width}px`);
    assert.equal(first.imagePanel, true, `image panel must be on the first screen at ${width}px`);
    assert.match(first.imageTitle, /Image/i);
    assert.match(first.animTitle, /Animation/i);
    assert.ok(first.imageTop < first.animTop, 'the image panel stays above the animation panel');
    note(`${name}: first screen ok (scrollWidth ${first.scroll} <= ${first.width}, connect disabled=${first.connectDisabled})`);

    // Real GIF import through the existing file input.
    await page.locator('#file').setInputFiles(FIXTURE);
    await page.waitForFunction(() => /sample\.gif/.test(document.querySelector('#anim-name')?.textContent || ''));
    const panel = await page.evaluate(() => ({
      frames: document.querySelector('#anim-frame-count')?.textContent?.trim(),
      bytes: document.querySelector('#anim-encoded-bytes')?.textContent?.trim(),
      ratio: document.querySelector('#anim-ratio')?.textContent?.trim(),
      time: document.querySelector('#anim-ble-time')?.textContent?.trim(),
      assumption: document.querySelector('#anim-assumption')?.textContent?.trim(),
      counter: document.querySelector('#anim-counter')?.textContent?.trim(),
      status: document.querySelector('#anim-status')?.textContent?.trim(),
      warning: document.querySelector('#anim-warning')?.hidden ? '' : document.querySelector('#anim-warning')?.textContent?.trim(),
      imageName: document.querySelector('#image-name')?.textContent?.trim(),
      playEnabled: !document.querySelector('#anim-play')?.disabled,
      sendDisabled: document.querySelector('#anim-send')?.disabled,
      resumeText: document.querySelector('#anim-device-resume')?.textContent?.trim(),
      resumeDisabled: document.querySelector('#anim-device-resume')?.disabled,
      deviceState: document.querySelector('#anim-device-state')?.textContent?.trim(),
      canvasInk: (() => {
        const canvas = document.querySelector('#anim-preview');
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let black = 0, white = 0;
        for (let i = 0; i < data.length; i += 4) (data[i] === 0 ? black++ : white++);
        return { black, white };
      })()
    }));
    assert.equal(panel.frames, '4', `stats must report 4 frames, got ${panel.frames}`);
    assert.ok(Number(panel.frames) > 0);
    assert.match(panel.bytes, /KB|B/, 'encoded byte total must be shown');
    assert.match(panel.ratio, /×/, 'compression ratio must be shown');
    assert.match(panel.time, /ms|s/, 'estimated transfer time must be shown');
    assert.match(panel.assumption, /MTU 23|capabilities/i, 'the estimate assumption must be visible');
    assert.match(panel.counter, /Frame 1 \/ 4/);
    assert.match(panel.status, /4 frames ready/);
    assert.match(panel.imageName, /No image selected/, 'a GIF must not replace the static image');
    assert.equal(panel.playEnabled, true, 'play must be enabled after import');
    assert.equal(panel.sendDisabled, true, 'send must stay disabled without a connection');
    assert.equal(panel.resumeText, 'Resume', 'the resume control must be present');
    assert.equal(panel.resumeDisabled, true, 'resume needs a connection');
    assert.match(panel.deviceState, /unknown/i);
    assert.ok(panel.canvasInk.black > 100 && panel.canvasInk.white > 100, `preview must render real pixels: ${JSON.stringify(panel.canvasInk)}`);
    note(`${name}: stats ${panel.frames} frames, ${panel.bytes}, ${panel.ratio}, ${panel.time}; ${panel.assumption}`);

    // Playback advances the frame counter at the real delays.
    await page.locator('#anim-play').click();
    await page.waitForFunction(() => /Frame (2|3|4) \/ 4/.test(document.querySelector('#anim-counter')?.textContent || ''), null, { timeout: 4000 });
    await page.locator('#anim-pause').click();
    const paused = await page.locator('#anim-counter').textContent();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#anim-counter').textContent(), paused, 'pause must stop the preview');
    note(`${name}: playback advanced to "${paused.trim()}" and paused`);

    // Throttling recomputes the stats before sending.
    await page.locator('#anim-keep').selectOption('2');
    await page.waitForFunction(() => document.querySelector('#anim-frame-count')?.textContent?.trim() === '2');
    const throttled = await page.evaluate(() => ({
      frames: document.querySelector('#anim-frame-count').textContent.trim(),
      bytes: document.querySelector('#anim-encoded-bytes').textContent.trim(),
      time: document.querySelector('#anim-ble-time').textContent.trim()
    }));
    assert.equal(throttled.frames, '2');
    note(`${name}: keep every 2nd -> ${throttled.frames} frames, ${throttled.bytes}, ${throttled.time}`);
    await page.locator('#anim-keep').selectOption('1');

    const layout = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
      overflowing: [...document.querySelectorAll('main *')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      }).map(element => element.id || element.tagName)
    }));
    assert.ok(layout.scroll <= layout.width, `overflow after import at ${width}px: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.overflowing, [], `clipped elements at ${width}px`);
    assert.deepEqual(errors, [], `page errors at ${width}px`);
    assert.deepEqual(consoleErrors, [], `console errors at ${width}px`);
    const external = requests.filter(url => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
    assert.deepEqual(external, [], `external requests: ${external.join(', ')}`);

    const path = resolve(ARTIFACTS, `anim-ui-${name}.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    results.push({ name, width, height, frames: panel.frames, bytes: panel.bytes, ratio: panel.ratio, time: panel.time, throttled: throttled.frames, errors, consoleErrors, external, screenshot: path });
    note(`${name}: wrote ${path} (${statSync(path).size} bytes)`);
    await context.close();
  }

  // Russian locale, 390 px.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const page = await context.newPage();
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(URL_BASE);
  await page.locator('#language-select').selectOption('ru');
  await page.locator('#file').setInputFiles(FIXTURE);
  await page.waitForFunction(() => /sample\.gif/.test(document.querySelector('#anim-name')?.textContent || ''));
  const ru = await page.evaluate(() => ({
    title: document.querySelector('#anim-title')?.textContent?.trim(),
    open: document.querySelector('#anim-open')?.textContent?.trim(),
    play: document.querySelector('#anim-play')?.textContent?.trim(),
    stats: document.querySelector('#anim-stats-legend')?.textContent?.trim() || document.querySelector('.anim-stats')?.previousElementSibling?.textContent?.trim(),
    framesLabel: document.querySelector('.anim-stats dt')?.textContent?.trim(),
    timeLabel: document.querySelector('.anim-stats dt:nth-of-type(4)')?.textContent?.trim(),
    counter: document.querySelector('#anim-counter')?.textContent?.trim(),
    status: document.querySelector('#anim-status')?.textContent?.trim(),
    keepLabel: document.querySelector('label[for="anim-keep"]')?.textContent?.trim() || document.querySelector('#anim-keep')?.closest('label')?.textContent?.trim(),
    lang: document.documentElement.lang,
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth
  }));
  assert.equal(ru.lang, 'ru');
  assert.match(ru.title, /Анимация/, 'the animation panel title must be Russian');
  assert.match(ru.open, /Открыть анимацию/);
  assert.match(ru.play, /Пуск/);
  assert.match(ru.framesLabel, /Кадров/);
  assert.match(ru.timeLabel, /Оценка времени/);
  assert.match(ru.counter, /Кадр 1 \/ 4/);
  assert.match(ru.status, /готово кадров/);
  assert.match(ru.keepLabel, /Брать каждый/);
  const ruResume = await page.locator('#anim-device-resume').textContent();
  assert.match(ruResume, /Продолжить/, 'the resume control must be Russian');
  note(`ru-390: resume control "${ruResume.trim()}"`);
  assert.ok(ru.scroll <= ru.width, `Russian layout overflows at 390px: ${JSON.stringify(ru)}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  const path = resolve(ARTIFACTS, 'anim-ui-ru-390.png');
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
  results.push({ name: 'ru-390', width: 390, title: ru.title, counter: ru.counter, status: ru.status, errors, consoleErrors, screenshot: path });
  note(`ru-390: ${ru.title} / ${ru.play} / ${ru.framesLabel} / ${ru.counter}; wrote ${path} (${statSync(path).size} bytes)`);
  await context.close();

  for (const shot of shots) {
    const { size } = statSync(shot);
    assert.ok(size > 20000, `screenshot ${shot} is suspiciously small (${size} bytes)`);
  }
  note('screenshots:', shots.map(shot => `${shot} (${statSync(shot).size} B)`).join(', '));
  await writeFile(resolve(ARTIFACTS, 'anim-ui-smoke.json'), JSON.stringify({ engine, results }, null, 2) + '\n');
  note('PASS');
} catch (error) {
  note('FAIL', error.message);
  log.push(error.stack || '');
  throw error;
} finally {
  await browser.close();
  server.close();
  await writeFile(LOG, log.join('\n') + '\n');
}
