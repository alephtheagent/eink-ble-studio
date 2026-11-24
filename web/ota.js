import { t, subscribeLanguage } from './i18n.js';
//
// Static, local-only ZIP extraction and legacy / Secure DFU transports.
//
// Contract (tests/ota.test.js): DFU_OPCODE, DFU_SERVICE, OtaError,
// parseRelease, selectDfuAsset, initOta.

export const DFU_OPCODE = 0x05;
export const DFU_SERVICE = 0xfe59;
const LEGACY_DFU_SERVICE = '00001530-1212-efde-1523-785feabcd123';
const transportName = pkg => pkg.transport === 'legacy' ? t('ota.legacyTransport') : t('ota.secureTransport');

// The repository API base lives in one place; the endpoint suffixes are added
// when requesting so the policy-checked base URL stays literal.
const RELEASES_API = 'https://api.github.com/repos/alephtheagent/eink-ble-studio/releases';
const RELEASES_LATEST = `${RELEASES_API}/latest`;
const ENTER_DFU_TIMEOUT_MS = 4000;
const MANUAL_HINT = () => t('firmware.manualHint');

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
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new OtaError('NO_PACKAGE', t('ota.noReleaseInfo'));
  if (typeof json.tag_name !== 'string' || !json.tag_name.trim()) throw new OtaError('NO_PACKAGE', t('ota.noTag'));
  if (!Array.isArray(json.assets)) throw new OtaError('NO_PACKAGE', t('ota.noAssetList'));
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
  if (!asset) throw new OtaError('NO_PACKAGE', t('ota.noPackage'));
  return asset;
}

const assetUrl = asset => asset?.browser_download_url || asset?.url || '';
const formatSize = size => t('firmware.byteSize', { bytes: size, kilobytes: (size / 1024).toFixed(1) });

// Both backends expose an update promise decorated with an abort() handle.
function defaultDfuFactory({ package: pkg, device, onProgress = () => {} } = {}) {
  if (!pkg || !pkg.init || !pkg.firmware) throw new OtaError('NO_PACKAGE', t('ota.packageNotPrepared'));
  if (pkg.transport === 'legacy') {
    if (!globalThis.LegacyDfu) throw new OtaError('LIBS_MISSING', t('ota.legacyLibraryMissing'));
    const dfu = new globalThis.LegacyDfu({
      bluetooth: globalThis.navigator?.bluetooth,
      translate: t,
      onProgress,
      onLog: message => onProgress(Number.NaN, 0, message),
    });
    const promise = dfu.update(device, { init: pkg.init, firmware: pkg.firmware });
    promise.abort = () => dfu.abort();
    return promise;
  }
  const SecureDfu = globalThis.SecureDfu;
  const CRC32 = globalThis.CRC32;
  if (!SecureDfu || !CRC32) throw new OtaError('LIBS_MISSING', t('ota.dfuLibrariesMissing'));
  const dfu = new SecureDfu(bytes => CRC32.buf(new Uint8Array(bytes)), globalThis.navigator?.bluetooth, 0);
  let aborted = false;
  const rejectPending = message => {
    for (const pending of Object.values(dfu.notifyFns || {})) pending.reject(new Error(message));
  };
  const onDisconnect = () => rejectPending(t('ota.connectionLost'));
  device.addEventListener('gattserverdisconnected', onDisconnect);
  const connect = dfu.gattConnect.bind(dfu);
  dfu.gattConnect = (...args) => connect(...args).then(result => {
    if (aborted) {
      device.gatt.disconnect();
      throw new Error(t('ota.cancelled'));
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
    if (!valid && transferringObject) throw new Error(t('ota.checksumMismatch'));
    return valid;
  };
  // The vendored sendOperation leaves its promise pending when a GATT write
  // fails. Propagate that failure instead of hanging the updater indefinitely.
  dfu.sendOperation = (characteristic, operation, data) => new Promise((resolve, reject) => {
    if (aborted) { reject(new Error(t('ota.cancelled'))); return; }
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
  dfu.transferData = (...args) => aborted ? Promise.reject(new Error(t('ota.cancelled'))) : transferData(...args);
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
      if (detail.message) onProgress(Number.NaN, 0, detail.message);
    });
  }
  const promise = dfu.update(device, pkg.init, pkg.firmware).finally(() => {
    device.removeEventListener('gattserverdisconnected', onDisconnect);
  });
  promise.abort = () => {
    aborted = true;
    rejectPending(t('ota.cancelled'));
    try { device.gatt.disconnect(); } catch {}
  };
  return promise;
}

// Both formats use application dat/bin files; dfu_version identifies legacy.
async function extractPackage(bytes) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new OtaError('LIBS_MISSING', t('ota.zipLibraryMissing'));
  try {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.files['manifest.json']) throw new Error(t('ota.manifestMissing'));
    const manifest = JSON.parse(await zip.files['manifest.json'].async('string')).manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(t('ota.manifestInvalid'));
    const legacy = Object.hasOwn(manifest, 'dfu_version');
    if (legacy && manifest.dfu_version !== 0.5) throw new Error(t('ota.legacyUnsupported'));
    const app = manifest.application;
    if (!app || typeof app.dat_file !== 'string' || typeof app.bin_file !== 'string' ||
        !zip.files[app.dat_file] || zip.files[app.dat_file].dir ||
        !zip.files[app.bin_file] || zip.files[app.bin_file].dir ||
        Object.keys(manifest).some(key => key !== 'application' && !(legacy && key === 'dfu_version'))) {
      throw new Error(t('ota.applicationManifestExpected'));
    }
    const init = await zip.files[app.dat_file].async('arraybuffer');
    const firmware = await zip.files[app.bin_file].async('arraybuffer');
    if (!init.byteLength || !firmware.byteLength) throw new Error(t('ota.applicationFilesEmpty'));
    return { init, firmware, transport: legacy ? 'legacy' : 'secure', initName: app.dat_file, firmwareName: app.bin_file };
  } catch (error) {
    throw new OtaError('BAD_PACKAGE', t('ota.invalidPackage', { error: error.message }));
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

  let statusRenderer = () => '';
  function setStatus(render) {
    statusRenderer = typeof render === 'function' ? render : () => String(render);
    if (el.status) el.status.textContent = statusRenderer();
  }

  function sync() {
    const hasPackage = Boolean(state.release && state.asset && state.package);
    const confirmed = Boolean(el.confirm?.checked);
    if (el.support) el.support.textContent = t(supported ? 'firmware.supportAvailable' : 'firmware.supportUnavailable');
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
    if (el.version) el.version.textContent = tag ? t('firmware.latestRelease', { tag }) : t('firmware.latestNotChecked');
    if (el.size) el.size.textContent = state.asset ? t('firmware.packageSize', { size: formatSize(state.asset.size) }) : t('firmware.packageSizeUnknown');
  }

  async function fetchJson(url) {
    if (!fetcher) throw new OtaError('NETWORK', t('firmware.networkUnavailable'));
    let response;
    try {
      response = await fetcher(url);
    } catch (error) {
      throw new OtaError('NETWORK', t('firmware.networkError', { error: error?.message || t('firmware.fetchFailed') }));
    }
    if (!response) throw new OtaError('NETWORK', t('firmware.networkEmpty'));
    if (!response.ok) throw new OtaError('HTTP', t('firmware.httpError', { status: response.status ?? t('firmware.httpUnknown') }));
    try {
      return await response.json();
    } catch (error) {
      throw new OtaError('NETWORK', t('firmware.releaseReadError', { error: error.message }));
    }
  }

  async function refresh() {
    if (!supported) {
      setStatus(() => t('firmware.bluetoothUnavailable'));
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
    setStatus(() => t('firmware.checking'));
    sync();
    try {
      const release = parseRelease(await fetchJson(RELEASES_LATEST));
      const asset = selectDfuAsset(release);
      state.release = release;
      state.asset = asset;
      renderRelease();
      const url = assetUrl(asset);
      if (!url) throw new OtaError('NO_PACKAGE', t('firmware.noDownloadUrl'));
      setStatus(() => t('firmware.downloading', { name: asset.name, size: formatSize(asset.size) }));
      // A GitHub release asset redirects to release-assets.githubusercontent.com, which
      // sends no Access-Control-Allow-Origin, so the browser cannot read it. Because of
      // that the Pages workflow publishes the same package next to the site; try that
      // first and keep the release URL as a fallback for other deployments.
      const href = globalThis.location?.href || '';
      const base = /^https?:/.test(href) ? href : 'https://alephtheagent.github.io/eink-ble-studio/';
      const localUrl = new URL(`firmware/latest-dfu.zip?v=${encodeURIComponent(release.tag)}`, base).href;
      let response = null;
      try { response = await fetcher(localUrl); } catch { response = null; }
      if (!response?.ok) {
        try { response = await fetcher(url); }
        catch (error) { throw new OtaError('DOWNLOAD_FAILED', t('firmware.downloadFailedCors', { error: error?.message || error })); }
      }
      if (!response?.ok) throw new OtaError('DOWNLOAD_FAILED', t('firmware.downloadFailedHttp', { status: response?.status ?? t('firmware.httpUnknown') }));
      const bytes = new Uint8Array(await response.arrayBuffer());
      state.package = await extractPackage(bytes);
      state.zipBytes = bytes;
      setStatus(() => t('firmware.releaseReady', { tag: release.tag, transport: transportName(state.package), name: asset.name, size: formatSize(asset.size) }));
      return release;
    } catch (error) {
      state.package = null;
      state.zipBytes = null;
      setStatus(() => t('firmware.packageUnavailable', { code: error?.code ? ` (${error.code})` : '', error: error?.message || t('firmware.unknownFailure') }));
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
      setStatus(() => t('firmware.connectFirst'));
      return;
    }
    state.enteringDfu = true;
    sync();
    setStatus(() => t('firmware.requestingDfu'));

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

    const onDisconnect = () => finish(() => t('firmware.deviceDisconnectedDfu'), true);
    entryListener = { device, fn: onDisconnect };
    try { device.addEventListener?.('gattserverdisconnected', onDisconnect); } catch {}

    entryTimer = setTimeout(() => {
      timedOut = true;
      finish(() => t('firmware.dfuTimeout', { seconds: ENTER_DFU_TIMEOUT_MS / 1000, hint: MANUAL_HINT() }));
    }, ENTER_DFU_TIMEOUT_MS);

    (async () => {
      try {
        await transport.writeWithResponse(transport.command, Uint8Array.of(DFU_OPCODE));
      } catch (error) {
        finish(() => t('firmware.dfuRejected', { error: error?.message || t('firmware.writeRejected'), hint: MANUAL_HINT() }));
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
            finish(() => t('firmware.dfuMalformed', { hint: MANUAL_HINT() }));
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
    if (note) setStatus(() => t('ota.dfUProgress', { message: note }));
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
    setStatus(() => t('firmware.cancellationRequested'));
    sync();
  }

  async function startFlash() {
    if (!supported) return;
    if (state.busy) return;
    if (!state.release || !state.asset || !state.package) { setStatus(() => t('firmware.noPackageToFlash')); return; }
    if (!el.confirm?.checked) { setStatus(() => t('firmware.confirmRisk')); return; }
    if (!requestDevice) { setStatus(() => t('firmware.devicePickerUnavailable')); return; }

    state.busy = true;
    state.cancelled = false;
    state.dfuRunning = false;
    lastProgress = 0;
    if (el.progress) { el.progress.max = 100; el.progress.value = 0; }
    sync();
    setStatus(() => t('firmware.chooseBootloader', { transport: transportName(state.package) }));

    try {
      // This call must run directly in the click handler, before any await:
      // Web Bluetooth requires transient user activation for every chooser.
      // Chrome rejects requestDevice() when a services filter names a blocklisted
      // UUID, and the DFU service 0xFE59 is on that list, so the chooser cannot be
      // narrowed by service. List every nearby device and grant both DFU services up
      // front; the transport then picks the one the bootloader actually exposes.
      const device = await requestDevice({
        acceptAllDevices: true,
        optionalServices: [LEGACY_DFU_SERVICE, DFU_SERVICE],
      });
      if (state.cancelled) return;

      setStatus(() => t('firmware.flashing', { transport: transportName(state.package) }));
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
        setStatus(() => t('firmware.finished'));
      }
    } catch (error) {
      if (!state.cancelled) {
        const detail = error?.message || String(error);
        const code = error?.code ? ` (${error.code})` : '';
        setStatus(() => t('firmware.failed', { code, error: detail }));
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
  setStatus(() => t('firmware.checkFirst'));
  subscribeLanguage(() => {
    renderRelease();
    sync();
    if (el.status) el.status.textContent = statusRenderer();
  });

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
