import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = () => fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const FIXTURES = path.join(ROOT, 'tests/fixtures/ota');
const fixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

let otaModule;
async function loadOta() {
  if (!otaModule) otaModule = await import('../web/ota.js');
  return otaModule;
}

function makeDom({ bluetooth } = {}) {
  const dom = new JSDOM(HTML(), { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  window.setImmediate = globalThis.setImmediate;
  window.clearImmediate = globalThis.clearImmediate;
  window.eval(fs.readFileSync(path.join(ROOT, 'web/vendor/jszip.min.js'), 'utf8'));
  const zipClass = window.JSZip;
  const loadZip = zipClass.loadAsync.bind(zipClass);
  zipClass.loadAsync = (bytes, options) => loadZip(new window.Uint8Array(bytes), options);
  Object.defineProperty(globalThis, 'JSZip', { value: zipClass, configurable: true });
  const nav = bluetooth === undefined ? {} : { bluetooth };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;
  return dom;
}

function els(dom) {
  const doc = dom.window.document;
  const $ = id => {
    const el = doc.getElementById(id);
    assert.ok(el, `missing #${id} in web/index.html`);
    return el;
  };
  return {
    $,
    action: name => {
      const el = doc.querySelector(`[data-action="${name}"]`);
      assert.ok(el, `missing [data-action="${name}"]`);
      return el;
    },
    status: () => $('fw-status').textContent.trim(),
    version: () => $('fw-version').textContent.trim(),
  };
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
async function waitFor(cond, ms = 1000, step = 5) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

function releaseFetch({ latest, list, zipType = 'application' } = {}) {
  const calls = [];
  const fetch = async url => {
    const u = String(url);
    calls.push(u);
    if (/\/releases\/latest$/.test(u)) {
      if (latest === '404') return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      if (latest === 'throw') throw new TypeError('Failed to fetch');
      if (latest !== undefined) return { ok: true, status: 200, json: async () => latest };
    }
    if (/\/releases(\?|$)/.test(u)) {
      if (list !== undefined) return { ok: true, status: 200, json: async () => list };
    }
    const zipBytes = async () => {
      if (zipType === 'invalid') return new TextEncoder().encode('not a zip');
      const zip = new globalThis.JSZip();
      const manifest = { manifest: { application: { dat_file: 'application.dat', bin_file: 'application.bin' } } };
      if (zipType === 'legacy') manifest.manifest.dfu_version = 0.5;
      if (zipType === 'unsupported-legacy') manifest.manifest.dfu_version = 0.6;
      if (zipType === 'mixed') manifest.manifest.bootloader = { dat_file: 'application.dat', bin_file: 'application.bin' };
      zip.file('manifest.json', JSON.stringify(manifest));
      zip.file('application.dat', 'init-packet');
      zip.file('application.bin', 'firmware-image');
      return zip.generateAsync({ type: 'uint8array' });
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => {
        const bytes = await zipBytes();
        const browserBytes = new globalThis.window.Uint8Array(bytes);
        return browserBytes.buffer;
      },
      blob: async () => new Blob([await zipBytes()]),
    };
  };
  return { fetch, calls };
}

function makeDevice({ write } = {}) {
  const listeners = new Map();
  const writes = [];
  const characteristic = {
    uuid: '7b1e0002-6ba2-4f25-8ac7-1d54e91a1000',
    properties: { write: true, writeWithoutResponse: false },
    async writeValueWithResponse(bytes) {
      writes.push(Uint8Array.from(bytes));
      if (write) return write(bytes, device);
    },
    async writeValue(bytes) { return this.writeValueWithResponse(bytes); },
  };
  const service = {
    async getCharacteristic() { return characteristic; },
    async getCharacteristics() { return [characteristic]; },
  };
  const server = {
    async getPrimaryService() { return service; },
    async getPrimaryServices() { return [service]; },
  };
  const device = {
    id: 'fake-device',
    name: 'eink-ble-bw',
    writes,
    characteristic,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true; },
    gatt: {
      connected: true,
      async connect() { this.connected = true; return server; },
      disconnect() { this.connected = false; device.dispatchEvent(new globalThis.Event('gattserverdisconnected')); },
    },
  };
  return device;
}

function makeTransport(device) {
  return {
    device,
    command: device.characteristic,
    async connect() { return device; },
    disconnect() {},
    async writeWithResponse(characteristic, bytes) { return characteristic.writeValueWithResponse(bytes); },
  };
}

function makeDfu(options = {}) {
  const calls = [];
  const dfuFactory = (...args) => { calls.push(args); return options.impl ? options.impl(...args) : Promise.resolve(); };
  return { dfuFactory, calls };
}

async function init(dom, { fetch, requestDevice, dfuFactory, transport } = {}) {
  const { initOta } = await loadOta();
  const ota = await initOta({
    document: dom.window.document,
    transport,
    fetch,
    requestDevice,
    dfuFactory,
  });
  assert.ok(ota && typeof ota.refresh === 'function', 'initOta must return {refresh, setConnected, state}');
  return ota;
}


test('parseRelease rejects invalid payloads with NO_PACKAGE', async () => {
  const { parseRelease, OtaError } = await loadOta();
  for (const bad of [null, {}, { tag_name: 1 }, { tag_name: 'v1', assets: 'nope' }]) {
    let caught;
    try { parseRelease(bad); } catch (error) { caught = error; }
    assert.ok(caught, `parseRelease(${JSON.stringify(bad)}) must throw`);
    assert.ok(caught instanceof OtaError || typeof caught.code === 'string');
    assert.equal(caught.code, 'NO_PACKAGE');
  }
});

test('parseRelease provides tag and selectable asset fields from a GitHub release', async () => {
  const { parseRelease } = await loadOta();
  const release = parseRelease(fixture('release-latest.json'));
  assert.equal(release.tag, 'v2.1.0');
  assert.equal(release.assets.length, 2);
  const asset = release.assets.find(item => item.name.endsWith('-dfu.zip'));
  assert.deepEqual(
    { name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url },
    {
      name: 'eink-ble-bw-s140v6-dfu.zip',
      size: 103424,
      downloadUrl: 'https://github.com/eink/ble-bw/releases/download/v2.1.0/eink-ble-bw-s140v6-dfu.zip',
    },
  );
});

test('selectDfuAsset prefers -dfu.zip, ignores .uf2, and is case-insensitive', async () => {
  const { parseRelease, selectDfuAsset } = await loadOta();
  const release = parseRelease(fixture('release-latest.json'));
  const asset = selectDfuAsset(release);
  assert.ok(asset, 'selectDfuAsset must return the DFU asset');
  assert.equal(asset.name, 'eink-ble-bw-s140v6-dfu.zip');
  assert.equal(asset.size, 103424);
  assert.match(asset.browser_download_url ?? asset.url ?? '', /eink-ble-bw-s140v6-dfu\.zip$/);

  const upper = JSON.parse(JSON.stringify(release));
  const dfu = (upper.assets || []).find(a => /-dfu\.zip$/i.test(a.name));
  assert.ok(dfu);
  dfu.name = 'EINK-BLE-BW-S140V6-DFU.ZIP';
  assert.equal(selectDfuAsset(upper).name, 'EINK-BLE-BW-S140V6-DFU.ZIP');
});

test('selectDfuAsset throws NO_PACKAGE for a release without a DFU zip', async () => {
  const { parseRelease, selectDfuAsset, OtaError } = await loadOta();
  const release = parseRelease(fixture('release-no-dfu.json'));
  let caught;
  try { selectDfuAsset(release); } catch (error) { caught = error; }
  assert.ok(caught, 'selectDfuAsset must throw when only a .uf2 exists');
  assert.equal(caught.code, 'NO_PACKAGE');
  assert.ok(caught instanceof OtaError || caught.code === 'NO_PACKAGE');
});

test('refresh without a DFU package disables flash and says no package', async () => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const { fetch } = releaseFetch({ latest: fixture('release-no-dfu.json') });
    const ota = await init(dom, { fetch, transport: makeTransport(makeDevice()), requestDevice: async () => makeDevice() });
    ota.setConnected?.(true);
    await ota.refresh();
    await flush();
    assert.equal($('fw-flash').disabled, true);
    assert.match(status(), /package/i);
    assert.match(status(), /no|not|missing|unavailable/i);
  } finally { dom.window.close(); }
});

test('latest release without DFU is not replaced by an older packaged release', async () => {
  const dom = makeDom();
  try {
    const $ = els(dom).$;
    const latest = fixture('release-no-dfu.json');
    const { fetch, calls } = releaseFetch({ latest, list: fixture('release-list.json') });
    const ota = await init(dom, { fetch, requestDevice: async () => makeDevice() });
    await ota.refresh();
    assert.equal(ota.state.package, null);
    assert.equal($('fw-flash').disabled, true);
    assert.match(els(dom).status(), /NO_PACKAGE|package|available/i);
    assert.equal(calls.some(url => /\/releases\?/.test(url)), false, 'a valid latest response must not silently fall back to older releases');
  } finally { dom.window.close(); }
});

test('invalid ZIP is rejected even when a DFU implementation is injected', async () => {
  const dom = makeDom();
  try {
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json'), zipType: 'invalid' });
    const dfu = makeDfu();
    const ota = await init(dom, { fetch, requestDevice: async () => makeDevice(), dfuFactory: dfu.dfuFactory });
    await ota.refresh();
    assert.equal(ota.state.package, null);
    assert.match(els(dom).status(), /BAD_PACKAGE|package|zip/i);
    assert.equal(dfu.calls.length, 0);
  } finally { dom.window.close(); }
});

test('legacy application manifest is accepted and distinguished from Secure DFU', async () => {
  const dom = makeDom();
  try {
    for (const [zipType, expected] of [['legacy', 'legacy'], ['application', 'secure']]) {
      const { fetch } = releaseFetch({ latest: fixture('release-latest.json'), zipType });
      const ota = await init(dom, { fetch, requestDevice: async () => makeDevice(), dfuFactory: makeDfu().dfuFactory });
      await ota.refresh();
      assert.equal(ota.state.package.transport, expected);
      assert.match(els(dom).status(), expected === 'legacy' ? /Legacy DFU 0.5.*Adafruit/ : /Nordic Secure DFU/);
    }
  } finally { dom.window.close(); }
});

test('unsupported legacy version and mixed images cannot be flashed', async () => {
  const dom = makeDom();
  try {
    for (const zipType of ['unsupported-legacy', 'mixed']) {
      const { fetch } = releaseFetch({ latest: fixture('release-latest.json'), zipType });
      const ota = await init(dom, { fetch, requestDevice: async () => makeDevice() });
      await ota.refresh();
      assert.equal(ota.state.package, null);
      assert.equal(els(dom).$('fw-flash').disabled, true);
      assert.match(els(dom).status(), /BAD_PACKAGE/);
    }
  } finally { dom.window.close(); }
});

test('confirmation gates chooser and DFU; confirmed click chooses a fresh Secure DFU device', async () => {
  const dom = makeDom();
  try {
    const { $ } = els(dom);
    const { fetch, calls } = releaseFetch({ latest: fixture('release-latest.json') });
    const appDevice = makeDevice();
    const freshDfuDevice = makeDevice();
    const chooserCalls = [];
    const requestDevice = options => { chooserCalls.push(options); return Promise.resolve(freshDfuDevice); };
    const dfu = makeDfu({ impl: async () => { throw new Error('stop'); } });
    const ota = await init(dom, { fetch, transport: makeTransport(appDevice), requestDevice, dfuFactory: dfu.dfuFactory });
    ota.setConnected?.(true);
    await ota.refresh();
    await flush();
    assert.match(els(dom).version(), /v2\.1\.0/);
    assert.equal($('fw-flash').disabled, true);
    assert.ok(calls.some(u => /-dfu\.zip$/.test(u)), 'refresh validates and caches the selected package');

    $('fw-flash').click();
    await flush();
    assert.equal(chooserCalls.length, 0, 'unconfirmed flash must not open chooser');
    assert.equal(dfu.calls.length, 0, 'unconfirmed flash must not start DFU');

    $('fw-confirm').checked = true;
    $('fw-confirm').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal($('fw-flash').disabled, false);

    $('fw-confirm').checked = false;
    $('fw-confirm').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal($('fw-flash').disabled, true);

    $('fw-confirm').checked = true;
    $('fw-confirm').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    $('fw-flash').click();
    assert.equal(chooserCalls.length, 1, 'chooser must start directly from the confirmed click activation');
    const legacyService = '00001530-1212-efde-1523-785feabcd123';
    assert.deepEqual(chooserCalls[0], {
      filters: [{ services: [legacyService] }, { services: [0xfe59] }],
      optionalServices: [legacyService, 0xfe59],
    });
    await waitFor(() => dfu.calls.length > 0, 1000);
    assert.equal(dfu.calls.length, 1);
    const args = dfu.calls[0][0];
    assert.equal(args.device, freshDfuDevice, 'the connected editor device must not be reused');
    assert.equal(args.package, ota.state.package);
  } finally { dom.window.close(); }
});

test('404 on latest reports no release instead of silently installing an older release', async () => {
  const dom = makeDom();
  try {
    const { $, version } = els(dom);
    const { fetch, calls } = releaseFetch({ latest: '404', list: fixture('release-list.json') });
    const ota = await init(dom, { fetch, requestDevice: async () => makeDevice() });
    await ota.refresh();
    assert.equal(ota.state.package, null);
    assert.equal(calls.some(url => /\/releases\?/.test(url)), false);
    assert.match(els(dom).status(), /NO_PACKAGE|package|available/i);
  } finally { dom.window.close(); }
});

test('network failure shows NETWORK, re-enables check, and retry works', async () => {
  const dom = makeDom();
  try {
    const { $, version, status } = els(dom);
    let fail = true;
    const good = releaseFetch({ latest: fixture('release-latest.json') });
    const fetch = async (url) => { if (fail) { throw new TypeError('Failed to fetch'); } return good.fetch(url); };
    const ota = await init(dom, { fetch, transport: makeTransport(makeDevice()), requestDevice: async () => makeDevice() });
    ota.setConnected?.(true);
    await ota.refresh();
    await flush();
    assert.match(status(), /network|offline|connection|fetch/i);
    assert.equal($('fw-check').disabled, false);

    fail = false;
    await ota.refresh();
    await flush();
    assert.match(version(), /v2\.1\.0/);
    assert.equal($('fw-check').disabled, false);
  } finally { dom.window.close(); }
});

test('enter DFU: write resolves and gattserverdisconnected produces success', async () => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const device = makeDevice({ write: () => { setTimeout(() => device.gatt.disconnect(), 5); } });
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    const ota = await init(dom, { fetch, transport: makeTransport(device), requestDevice: async () => device });
    ota.setConnected?.(true);
    $('fw-enter-dfu').click();
    assert.ok(await waitFor(() => device.writes.length > 0 && /dfu|bootloader|reset/i.test(status()), 2000), status());
    assert.deepEqual([...device.writes[0]], [0x05]);
    assert.match(status(), /dfu|bootloader/i);
  } finally { dom.window.close(); }
});

test('enter DFU: write rejection mentions manual double RESET', async () => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const device = makeDevice({ write: async () => { throw new Error('GATT write failed'); } });
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    const ota = await init(dom, { fetch, transport: makeTransport(device), requestDevice: async () => device });
    ota.setConnected?.(true);
    $('fw-enter-dfu').click();
    assert.ok(await waitFor(() => /reset/i.test(status()), 2000), status());
    assert.match(status(), /double|twice|manual|reset.*reset/i);
  } finally { dom.window.close(); }
});

test('enter DFU: no disconnect times out with ENTER_DFU_TIMEOUT', async (t) => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const device = makeDevice();
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    const ota = await init(dom, { fetch, transport: makeTransport(device), requestDevice: async () => device });
    ota.setConnected?.(true);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    $('fw-enter-dfu').click();
    await flush();
    t.mock.timers.tick(5000);
    await flush(30);
    let ok = /timeout|did not disconnect|no disconnect/i.test(status());
    if (!ok) {
      // Fallback if the implementation used jsdom's window timer instead of the global one.
      t.mock.timers.reset();
      ok = await waitFor(() => /timeout|did not disconnect|no disconnect/i.test(status()), 5000);
    }
    assert.ok(ok, `expected ENTER_DFU_TIMEOUT message, got: ${status()}`);
    assert.match(status(), /timeout|did not disconnect|no disconnect/i);
    assert.match(status(), /reset/i, 'timeout must explain manual reset recovery');
    assert.equal($('fw-enter-dfu').disabled, false, 'DFU entry must be re-enabled after timeout');
  } finally { dom.window.close(); }
});

test('DFU failure reports DFU_FAILED, re-enables flash and resets progress', async () => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    const dfu = makeDfu({ impl: async () => { throw new Error('transfer exploded'); } });
    const ota = await init(dom, { fetch, transport: makeTransport(makeDevice()), requestDevice: async () => makeDevice(), dfuFactory: dfu.dfuFactory });
    ota.setConnected?.(true);
    await ota.refresh();
    await flush();
    $('fw-confirm').checked = true;
    $('fw-confirm').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    $('fw-flash').click();
    assert.ok(await waitFor(() => /dfu|firmware|flash/i.test(status()) && /fail|error/i.test(status()), 3000), status());
    assert.equal($('fw-flash').disabled, false);
    const progress = Number($('fw-progress').value ?? $('fw-progress').getAttribute('value') ?? 0);
    assert.notEqual(progress, 100);
  } finally { dom.window.close(); }
});

test('cancel remains busy until in-flight DFU settles and ignores late success', async () => {
  const dom = makeDom();
  try {
    const { $, status } = els(dom);
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const dfu = makeDfu({ impl: () => pending });
    const ota = await init(dom, { fetch, requestDevice: async () => makeDevice(), dfuFactory: dfu.dfuFactory });
    await ota.refresh();
    await flush();
    $('fw-confirm').checked = true;
    $('fw-confirm').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    $('fw-flash').click();
    assert.ok(await waitFor(() => dfu.calls.length > 0), 'DFU should be in flight before cancellation');
    $('fw-cancel').click();
    assert.match(status(), /cancel/i);
    assert.equal($('fw-flash').disabled, true, 'flash stays busy while the transfer promise is unresolved');
    finish();
    assert.ok(await waitFor(() => !$('fw-flash').disabled), 'flash becomes available after the in-flight promise settles');
    await flush();
    assert.match(status(), /cancel/i, 'late completion must not replace the cancellation result');
    assert.equal($('fw-cancel').disabled, true);
  } finally { dom.window.close(); }
});

test('missing navigator.bluetooth disables controls and explains Chromium/Android', async () => {
  const dom = makeDom();
  try {
    const { $ } = els(dom);
    const { fetch } = releaseFetch({ latest: fixture('release-latest.json') });
    await init(dom, { fetch, requestDevice: undefined, transport: makeTransport(makeDevice()) });
    await flush();
    for (const id of ['fw-check', 'fw-enter-dfu', 'fw-flash']) assert.equal($(id).disabled, true, `#${id} must be disabled`);
    assert.match($('fw-support').textContent, /chromium/i);
    assert.match($('fw-support').textContent, /android/i);
  } finally { dom.window.close(); }
});
