// OTA firmware update controller for E-Ink Studio.
//
// Static, local-only ZIP extraction and legacy / Secure DFU transports.
//
// Contract (tests/ota.test.js): DFU_OPCODE, DFU_SERVICE, OtaError,
// parseRelease, selectDfuAsset, initOta.

export const DFU_OPCODE = 0x05;
export const DFU_SERVICE = 0xfe59;
const LEGACY_DFU_SERVICE = '00001530-1212-efde-1523-785feabcd123';
const transportName = pkg => pkg.transport === 'legacy' ? 'Legacy DFU 0.5 (Adafruit)' : 'Nordic Secure DFU';

// The repository API base lives in one place; the endpoint suffixes are added
// when requesting so the policy-checked base URL stays literal.
const RELEASES_API = 'https://api.github.com/repos/alephtheagent/eink-ble-studio/releases';
const RELEASES_LATEST = `${RELEASES_API}/latest`;
const ENTER_DFU_TIMEOUT_MS = 4000;
const MANUAL_HINT = 'Enter DFU manually: press RESET twice quickly (double RESET), then use Flash firmware to choose the bootloader in the browser.';

export class OtaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OtaError';
    this.code = code;
  }
}

// Normalize a GitHub release payload. Anything without a usable tag and asset
// list is treated as "no package" rather than invented.
export function parseRelease(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new OtaError('NO_PACKAGE', 'No release information was returned.');
  if (typeof json.tag_name !== 'string' || !json.tag_name.trim()) throw new OtaError('NO_PACKAGE', 'Release has no tag name.');
  if (!Array.isArray(json.assets)) throw new OtaError('NO_PACKAGE', 'Release has no asset list.');
  return {
    tag: json.tag_name,
    name: typeof json.name === 'string' ? json.name : json.tag_name,
    body: typeof json.body === 'string' ? json.body : '',
    html_url: typeof json.html_url === 'string' ? json.html_url : '',
    published_at: typeof json.published_at === 'string' ? json.published_at : '',
    draft: !!json.draft,
    prerelease: !!json.prerelease,
    assets: json.assets.filter(asset => asset && typeof asset.name === 'string' && typeof asset.size === 'number'),
  };
}

export function selectDfuAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(candidate => typeof candidate?.name === 'string' && /-dfu\.zip$/i.test(candidate.name));
  if (!asset) throw new OtaError('NO_PACKAGE', 'This release has no DFU package (-dfu.zip).');
  return asset;
}

const assetUrl = asset => asset?.browser_download_url || asset?.url || '';
const formatSize = size => `${size} bytes (${(size / 1024).toFixed(1)} KB)`;

// Both backends expose an update promise decorated with an abort() handle.
function defaultDfuFactory({ package: pkg, device, onProgress = () => {} } = {}) {
  if (!pkg || !pkg.init || !pkg.firmware) throw new OtaError('NO_PACKAGE', 'No DFU package was prepared for transfer.');
  if (pkg.transport === 'legacy') {
    if (!globalThis.LegacyDfu) throw new OtaError('LIBS_MISSING', 'The bundled legacy-dfu.js library is not loaded.');
    const dfu = new globalThis.LegacyDfu({
      bluetooth: globalThis.navigator?.bluetooth,
      onProgress,
      onLog: message => onProgress(Number.NaN, 0, message),
    });
    const promise = dfu.update(device, { init: pkg.init, firmware: pkg.firmware });
    promise.abort = () => dfu.abort();
    return promise;
  }
  const SecureDfu = globalThis.SecureDfu;
  const CRC32 = globalThis.CRC32;
  if (!SecureDfu || !CRC32) throw new OtaError('LIBS_MISSING', 'The bundled DFU libraries (secure-dfu.js, crc32.js) are not loaded.');
  const dfu = new SecureDfu(bytes => CRC32.buf(new Uint8Array(bytes)), globalThis.navigator?.bluetooth, 0);
  let aborted = false;
  const rejectPending = message => {
    for (const pending of Object.values(dfu.notifyFns || {})) pending.reject(new Error(message));
  };
  const onDisconnect = () => rejectPending('DFU connection was lost.');
  device.addEventListener('gattserverdisconnected', onDisconnect);
  const connect = dfu.gattConnect.bind(dfu);
  dfu.gattConnect = (...args) => connect(...args).then(result => {
    if (aborted) {
      device.gatt.disconnect();
      throw new Error('DFU cancelled.');
    }
    return result;
  });
  let transferringObject = false;
  const transferObject = dfu.transferObject.bind(dfu);
  dfu.transferObject = (...args) => {
    transferringObject = true;
    return transferObject(...args);
  };
  const checkCrc = dfu.checkCrc.bind(dfu);
  dfu.checkCrc = (bytes, crc) => {
    const valid = checkCrc(bytes, crc);
    if (!valid && transferringObject) throw new Error('DFU checksum mismatch.');
    return valid;
  };
  // The vendored sendOperation leaves its promise pending when a GATT write
  // fails. Propagate that failure instead of hanging the updater indefinitely.
  dfu.sendOperation = (characteristic, operation, data) => new Promise((resolve, reject) => {
    if (aborted) { reject(new Error('DFU cancelled.')); return; }
    const bytes = new Uint8Array(operation.length + (data?.byteLength || 0));
    bytes.set(operation);
    if (data) bytes.set(new Uint8Array(data), operation.length);
    dfu.notifyFns[operation[0]] = { resolve, reject };
    Promise.resolve().then(() => characteristic.writeValue(bytes)).catch(error => {
      delete dfu.notifyFns[operation[0]];
      reject(error);
    });
  });
  const transferData = dfu.transferData.bind(dfu);
  dfu.transferData = (...args) => aborted ? Promise.reject(new Error('DFU cancelled.')) : transferData(...args);
  if (typeof dfu.addEventListener === 'function') {
    // EventDispatcher wraps Node's EventEmitter: listeners receive the detail
    // object itself, not a DOM event.
    // The vendored EventDispatcher forwards the detail payload itself, while a
    // DOM EventTarget would pass an Event with .detail; accept both.
    const payload = value => value?.detail ?? value ?? {};
    dfu.addEventListener(SecureDfu.EVENT_PROGRESS, value => {
      const detail = payload(value);
      if (detail.object === 'firmware') onProgress(Number(detail.currentBytes) || 0, Number(detail.totalBytes) || 0);
    });
    dfu.addEventListener(SecureDfu.EVENT_LOG, value => {
      const detail = payload(value);
      if (detail.message) onProgress(Number.NaN, 0, `DFU: ${detail.message}`);
    });
  }
  const promise = dfu.update(device, pkg.init, pkg.firmware).finally(() => {
    device.removeEventListener('gattserverdisconnected', onDisconnect);
  });
  promise.abort = () => {
    aborted = true;
    rejectPending('DFU cancelled.');
    try { device.gatt.disconnect(); } catch {}
  };
  return promise;
}

// Both formats use application dat/bin files; dfu_version identifies legacy.
async function extractPackage(bytes) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new OtaError('LIBS_MISSING', 'The bundled JSZip library is not loaded; cannot open the DFU package.');
  try {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.files['manifest.json']) throw new Error('manifest.json is missing');
    const manifest = JSON.parse(await zip.files['manifest.json'].async('string')).manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('expected a DFU manifest');
    const legacy = Object.hasOwn(manifest, 'dfu_version');
    if (legacy && manifest.dfu_version !== 0.5) throw new Error('only legacy DFU version 0.5 is supported');
    const app = manifest.application;
    if (!app || typeof app.dat_file !== 'string' || typeof app.bin_file !== 'string' ||
        !zip.files[app.dat_file] || zip.files[app.dat_file].dir ||
        !zip.files[app.bin_file] || zip.files[app.bin_file].dir ||
        Object.keys(manifest).some(key => key !== 'application' && !(legacy && key === 'dfu_version'))) {
      throw new Error('expected an application-only DFU manifest with matching dat_file and bin_file');
    }
    const init = await zip.files[app.dat_file].async('arraybuffer');
    const firmware = await zip.files[app.bin_file].async('arraybuffer');
    if (!init.byteLength || !firmware.byteLength) throw new Error('application files must not be empty');
    return { init, firmware, transport: legacy ? 'legacy' : 'secure', initName: app.dat_file, firmwareName: app.bin_file };
  } catch (error) {
    throw new OtaError('BAD_PACKAGE', `Invalid or unsupported DFU package: ${error.message}`);
  }
}

export function initOta(options = {}) {
  const doc = options.document || globalThis.document;
  const $ = id => doc?.getElementById?.(id) || null;
  const fetcher = typeof options.fetch === 'function'
    ? options.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const navBluetooth = globalThis.navigator?.bluetooth;
  let requestDevice = typeof options.requestDevice === 'function' ? options.requestDevice : null;
  if (!requestDevice && typeof navBluetooth?.requestDevice === 'function') requestDevice = navBluetooth.requestDevice.bind(navBluetooth);
  const transport = options.transport || null;
  const dfuFactory = typeof options.dfuFactory === 'function' ? options.dfuFactory : defaultDfuFactory;
  const supported = Boolean(requestDevice || navBluetooth);

  const el = {
    panel: $('firmware'),
    status: $('fw-status'),
    version: $('fw-version'),
    installed: $('fw-installed'),
    check: $('fw-check'),
    enter: $('fw-enter-dfu'),
    flash: $('fw-flash'),
    cancel: $('fw-cancel'),
    confirm: $('fw-confirm'),
    progress: $('fw-progress'),
    support: $('fw-support'),
    warning: $('fw-warning'),
    size: $('fw-size'),
  };

  const state = {
    supported,
    connected: Boolean(transport?.device?.gatt?.connected),
    refreshing: false,
    busy: false,
    enteringDfu: false,
    dfuRunning: false,
    cancelled: false,
    release: null,
    asset: null,
    package: null,
    zipBytes: null,
  };

  let activeHandle = null;
  let lastProgress = 0;
  let entryTimer = null;
  let entryListener = null;

  function setStatus(message) {
    if (el.status) el.status.textContent = message;
  }

  function sync() {
    const hasPackage = Boolean(state.release && state.asset && state.package);
    const confirmed = Boolean(el.confirm?.checked);
    if (el.support) {
      el.support.textContent = supported
        ? 'Works in Chrome/Edge desktop and Android Chrome. Firefox and Safari cannot run Web Bluetooth; use the .uf2 or a Chromium browser. After entering DFU you must choose the device again in the browser chooser.'
        : 'Web Bluetooth is unavailable. This updater requires a Chromium browser (Chrome or Edge on desktop, or Chrome on Android). Firefox and Safari cannot run Web Bluetooth; use the .uf2 or a Chromium browser.';
    }
    if (!supported) {
      if (el.check) el.check.disabled = true;
      if (el.enter) el.enter.disabled = true;
      if (el.flash) el.flash.disabled = true;
      if (el.cancel) el.cancel.disabled = true;
      return;
    }
    if (el.check) el.check.disabled = state.refreshing || state.busy;
    if (el.enter) el.enter.disabled = !(state.connected && !state.busy && !state.enteringDfu && !state.refreshing);
    if (el.flash) el.flash.disabled = !(requestDevice && hasPackage && confirmed && !state.busy && !state.enteringDfu && !state.refreshing);
    if (el.cancel) el.cancel.disabled = !state.busy;
  }

  function renderRelease() {
    const tag = state.release?.tag;
    if (el.version) el.version.textContent = tag ? `Latest release: ${tag}` : 'Latest release: not checked yet.';
    if (el.size) el.size.textContent = state.asset ? `Package size: ${formatSize(state.asset.size)}` : 'Package size: unknown.';
  }

  async function fetchJson(url) {
    if (!fetcher) throw new OtaError('NETWORK', 'Fetch is unavailable in this browser.');
    let response;
    try {
      response = await fetcher(url);
    } catch (error) {
      throw new OtaError('NETWORK', `Network error: could not reach GitHub (${error?.message || 'fetch failed'}). Check your connection and retry.`);
    }
    if (!response) throw new OtaError('NETWORK', 'Network error: empty response from GitHub.');
    if (!response.ok) throw new OtaError('HTTP', `GitHub returned HTTP ${response.status ?? 'error'}.`);
    try {
      return await response.json();
    } catch (error) {
      throw new OtaError('NETWORK', `Network error: release data could not be read (${error.message}).`);
    }
  }

  async function refresh() {
    if (!supported) {
      setStatus('Web Bluetooth is unavailable in this browser, so firmware updates cannot run here.');
      sync();
      return null;
    }
    if (state.refreshing || state.busy) return state.release;
    state.refreshing = true;
    state.release = null;
    state.asset = null;
    state.package = null;
    state.zipBytes = null;
    if (el.confirm) el.confirm.checked = false;
    renderRelease();
    setStatus('Checking GitHub for the latest firmware release…');
    sync();
    try {
      const release = parseRelease(await fetchJson(RELEASES_LATEST));
      const asset = selectDfuAsset(release);
      state.release = release;
      state.asset = asset;
      renderRelease();
      const url = assetUrl(asset);
      if (!url) throw new OtaError('NO_PACKAGE', 'The DFU package has no download URL.');
      setStatus(`Downloading ${asset.name} (${formatSize(asset.size)})…`);
      let response;
      try { response = await fetcher(url); }
      catch (error) { throw new OtaError('DOWNLOAD_FAILED', `Package download failed: ${error?.message || error}. GitHub metadata API CORS does not guarantee that release binaries allow browser downloads; the asset may be blocked by CORS or network policy.`); }
      if (!response?.ok) throw new OtaError('DOWNLOAD_FAILED', `Package download failed (HTTP ${response?.status ?? 'error'}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      state.package = await extractPackage(bytes);
      state.zipBytes = bytes;
      setStatus(`Release ${release.tag} ready: ${transportName(state.package)}, package ${asset.name} (${formatSize(asset.size)}). Confirm the risk before flashing.`);
      return release;
    } catch (error) {
      state.package = null;
      state.zipBytes = null;
      setStatus(`Firmware package unavailable${error?.code ? ` (${error.code})` : ''}: ${error?.message || 'unknown failure'}`);
      return null;
    } finally {
      state.refreshing = false;
      sync();
    }
  }

  function clearEntryWatch() {
    if (entryTimer !== null) { clearTimeout(entryTimer); entryTimer = null; }
    if (entryListener) {
      const { device, fn } = entryListener;
      try { device?.removeEventListener?.('gattserverdisconnected', fn); } catch {}
      entryListener = null;
    }
  }

  function enterDfuMode() {
    if (!supported || !state.connected) return;
    const device = transport?.device;
    if (!transport?.command || !device) {
      setStatus('Connect the display first. Entering DFU needs an active Bluetooth connection.');
      return;
    }
    state.enteringDfu = true;
    sync();
    setStatus('Requesting DFU mode (ENTER_DFU, opcode 0x05)…');

    let timedOut = false;
    // The device only counts as gone when it actually disconnected; a timeout
    // or a rejected write leaves the link up, so Enter DFU stays available for
    // a retry.
    const finish = (message, disconnected = false) => {
      if (!state.enteringDfu) return;
      clearEntryWatch();
      state.enteringDfu = false;
      if (disconnected) state.connected = false;
      setStatus(message);
      sync();
    };

    const onDisconnect = () => finish('The device disconnected after the DFU request. Use Flash firmware to choose the DFU bootloader again; disconnect alone does not confirm that DFU mode started.', true);
    entryListener = { device, fn: onDisconnect };
    try { device.addEventListener?.('gattserverdisconnected', onDisconnect); } catch {}

    entryTimer = setTimeout(() => {
      timedOut = true;
      finish(`DFU entry timeout: the device did not disconnect within ${ENTER_DFU_TIMEOUT_MS / 1000} s. This firmware may not support ENTER_DFU (opcode 0x05). ${MANUAL_HINT}`);
    }, ENTER_DFU_TIMEOUT_MS);

    (async () => {
      try {
        await transport.writeWithResponse(transport.command, Uint8Array.of(DFU_OPCODE));
      } catch (error) {
        finish(`Old firmware did not accept ENTER_DFU (opcode 0x05): ${error?.message || 'write rejected'}. ${MANUAL_HINT}`);
        return;
      }
      if (timedOut || !state.enteringDfu) return;
      // Old firmware accepts the ATT write but flags the opcode as malformed
      // (status error = 1) and stays connected. Surface the manual hint early
      // when the transport can read status; otherwise the timer handles it.
      if (typeof transport.readStatus === 'function' && transport.status) {
        try {
          const status = await transport.readStatus();
          if (status && status.error === 1) {
            finish(`Old firmware rejected ENTER_DFU (opcode 0x05) as malformed and stayed connected. ${MANUAL_HINT}`);
          }
        } catch { /* status read is best-effort */ }
      }
    })();
  }

  function setProgress(current, total, note) {
    if (!el.progress) return;
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      lastProgress = Math.max(lastProgress, Math.min(100, Math.round((current / total) * 100)));
      el.progress.max = 100;
      el.progress.value = lastProgress;
    }
    if (note) setStatus(note);
  }

  function cancelUpdate() {
    if (!state.busy) return;
    state.cancelled = true;
    const handle = activeHandle;
    try {
      if (typeof handle?.abort === 'function') handle.abort();
      else if (typeof handle?.cancel === 'function') handle.cancel();
    } catch {}
    // A browser chooser cannot be dismissed programmatically. Keep the operation
    // busy until it or the DFU backend settles, so a cancelled run cannot race a new one.
    setStatus('Cancellation requested. Close the device chooser if it is open; the device may remain in the bootloader and need another update.');
    sync();
  }

  async function startFlash() {
    if (!supported) return;
    if (state.busy) return;
    if (!state.release || !state.asset || !state.package) { setStatus('No DFU package is available to flash.'); return; }
    if (!el.confirm?.checked) { setStatus('Confirm that you understand the single-bank risk before flashing.'); return; }
    if (!requestDevice) { setStatus('Web Bluetooth device selection is unavailable.'); return; }

    state.busy = true;
    state.cancelled = false;
    state.dfuRunning = false;
    lastProgress = 0;
    if (el.progress) { el.progress.max = 100; el.progress.value = 0; }
    sync();
    setStatus(`Choose the DFU bootloader for ${transportName(state.package)} in the browser chooser…`);

    try {
      // This call must run directly in the click handler, before any await:
      // Web Bluetooth requires transient user activation for every chooser.
      const device = await requestDevice({
        filters: [{ services: [LEGACY_DFU_SERVICE] }, { services: [DFU_SERVICE] }],
        optionalServices: [LEGACY_DFU_SERVICE, DFU_SERVICE],
      });
      if (state.cancelled) return;

      setStatus(`Flashing via ${transportName(state.package)}… keep the tab open and stay close to the device.`);
      state.dfuRunning = true;
      sync();
      const handle = dfuFactory({
        package: state.package,
        zipBytes: state.zipBytes,
        device,
        onProgress: (current, total, note) => { if (!state.cancelled) setProgress(current, total, note); },
        signal: undefined,
      });
      activeHandle = handle;
      let running = handle;
      if (handle && typeof handle.then !== 'function') {
        if (typeof handle.run === 'function') running = handle.run();
        else if (typeof handle.start === 'function') running = handle.start();
        else if (typeof handle.transfer === 'function') running = handle.transfer();
        else running = undefined;
      }
      await running;
      if (!state.cancelled) {
        state.dfuRunning = false;
        if (el.progress) { el.progress.max = 100; el.progress.value = 100; }
        state.connected = false;
        if (el.confirm) el.confirm.checked = false;
        setStatus('Firmware update finished. The device restarts into the application; reconnect to send frames again.');
      }
    } catch (error) {
      if (!state.cancelled) {
        const detail = error?.message || String(error);
        const code = error?.code ? ` (${error.code})` : '';
        setStatus(`DFU failed${code}: ${detail}`);
      }
    } finally {
      activeHandle = null;
      state.busy = false;
      state.dfuRunning = false;
      if (state.cancelled) state.cancelled = false;
      sync();
    }
  }

  if (el.check) el.check.addEventListener('click', () => { refresh(); });
  if (el.enter) el.enter.addEventListener('click', enterDfuMode);
  if (el.flash) el.flash.addEventListener('click', () => { startFlash(); });
  if (el.cancel) el.cancel.addEventListener('click', cancelUpdate);
  for (const type of ['change', 'input']) el.confirm?.addEventListener(type, sync);

  renderRelease();
  sync();

  const api = {
    refresh,
    setConnected(value) {
      state.connected = Boolean(value);
      sync();
      return state;
    },
    state,
  };
  return api;
}
