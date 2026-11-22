# E-Ink Studio 1.1 task report

This report covers only checks actually executed in this worktree on 2026-11-22. Every path below is fresh output from this run. Earlier logs in `artifacts/` and the historical `REPORT.md`, `REPORT-V2.md`, `ADDITIVE-REPORT.md` and `OTA-REPORT.md` are not evidence for these results. No device was flashed, no radio or panel was exercised, and nothing was pushed, published or released.

## Software state checked

The repository contains the versioned page protocol v1 (opcodes `01` INFO, `02` LIST, `03` READ, `04` BEGIN, `05` DATA, `06` COMMIT, `07` DELETE, `08` BEGIN_ORDER, `09` ORDER_DATA, `0A` COMMIT_ORDER, `0B` ABORT, `0C` SHOW) on characteristics `0007`/`0008`/`0009`, documented in `docs/protocol-pages.md`, with the flash map and recovery model in `docs/storage.md`. The single-connection scope is confirmed against the pinned core: `begin(uint8_t prph_count = 1, uint8_t central_count = 0)` in Bluefruit52Lib `bluefruit.h:139`. V1 and v2 frame endpoints, DFU entry and boot welcome behavior are unchanged.

Page storage reserves `0xCC000..0xEC000` (32 erase sectors): two alternating metadata banks and thirty frame slots, one kept free for copy-on-write, therefore at most 29 live pages. The linker limit, UF2 and DFU checks use the exclusive limit `0xCC000`. The welcome sector `0xEC000..0xED000` and InternalFileSystem from `0xED000` are outside the application payload.

## Automated suite

`npm test` (JS tests followed by the host C++ compile/run) passed in the final run:

- `artifacts/task-verification/npm-current2-final.log` — 78 JS tests passed, 0 failed; the same log ends with the C++ protocol, boot-state and page-storage host runs (`python3 tests/run_cpp.py`), which also passed.

Covered by `npm test`:

- Existing conversion/CRC vectors, PackBits codec, v1/v2 packet framing, capability negotiation, GATT error/timeout/disconnect stages and OTA/legacy-DFU state machines, including explicit rejection, queue/refresh semantics and idempotent commits.
- `tests/page_storage.cpp` against the production `eink::pages::Storage<Flash>` header with an injected, absolute-address flash model: every interrupted stage of update, delete, reorder and create, including torn half-program and half-erase, followed by a simulated reboot; recovery of the old or new complete collection; rejection of an invalid newest metadata bank and of a corrupted newest frame with fallback to the previous committed bank; full device with one spare replacement, collection conflict and delete/reuse; and the endpoint display-copy ownership guard, where a queued SHOW makes the next INFO, second SHOW and stray DATA return `busy` until the driver takes the copy.
- `tests/pages-wire.test.js` drives the production `web/pages-wire.js` client against the production C++ `page_wire.h` endpoint and `page_storage.h` over a line-based bridge. It covers several distinct frames, multi-page readback, change of one page, order, delete with stale revision (`error.code === 4`), and reboot persistence.
- `tests/i18n.test.js` verifies EN/RU key and placeholder parity plus browser-preference selection, explicit switching, subscription, persistence, unsubscribe and fallback through jsdom.

Observed interruption counts in `npm-current2-final.log`: update 167, delete 69, reorder 101, create 199 distinct fail points, each followed by reboot recovery assertions. These are host-model results; they are not measurements of physical flash timing.

## Browser checks

Real Chromium (`/home/aleph/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome`, headless with `--no-sandbox --disable-dev-shm-usage`) loaded the actual site from a local static server.

`tools/task-ui.mjs`, log `artifacts/task-verification/ui-current2-final.log`:

- PASS at 320, 390 and 1280 px: text entry changes the rendered native frame; pencil, thickness, eraser and undo behave; magnified draw input lands on the expected native pixel; project export/import restores image source, text layers, drawing and the exact native frame; batch import with selected rotation/dither produces distinct frames equal to their previews; language switch retranslates the existing page status and persists across reload; no horizontal overflow; controls expose accessible names; no page errors.
- Screenshots: `ui-320-initial.png`, `ui-320-edited.png`, `ui-320-magnified.png`, `ui-320.png`; the same for 390 and 1280 (initial, edited, magnified, final). The edited images show composed text and drawing rather than an empty post-reload page.

`tools/task-sync.mjs`, log `artifacts/task-verification/sync-current2-final.log`:

- PASS using the real browser page code and the production `web/pages-wire.js` against the production C++ endpoint over simulated GATT, not fake echoes. It verifies receive replace/save/cancel dialogs, a received page restored as raster with an editable overlay, changed-only sync (exactly one 4000-byte frame uploaded), local deletion staged until Send changes, an ATT rejection before COMMIT delivery followed by ABORT and successful retry for both upload and reorder on the same connection, and a lost COMMIT acknowledgement after durable commit recovered by exporting the project, reloading, importing it, reconnecting and syncing without a duplicate write while preserving editable layers.

Simulated GATT and driver return are explicit; no RF link, bootloader or panel was involved.

## Firmware build and packaging

- Clean build `artifacts/task-verification/platformio-current2-clean.log` then `platformio-current2-build.log`: SUCCESS, Flash 155024 of 679936 bytes, RAM 28276 of 237568 bytes, image end `0x4bd90`, exclusive limit `0xcc000`, 606 UF2 blocks, welcome bitmap match. The endpoint guard in `firmware/include/page_wire.h` was already in the source for this build.
- Linked-code evidence `artifacts/task-verification/arm-current2-soc.log` and `arm-current2-wrapper.log`: `adafruit_soc_task` at `0x34670` contains `bl 0x2c3c8 <__wrap_flash_nrf5x_event_cb>` at `0x34716`; `__wrap_flash_nrf5x_event_cb` is at `0x2c3c8` while the unwrapped core symbol remains at `0x327c4`. This proves the linked call target, not hardware event routing.
- UF2 packaging `artifacts/task-verification/package-current2-uf2.log` and `verification-welcome-once-dfu.json`.
- Legacy DFU packaging `artifacts/task-verification/package-current2-dfu.log` and `dfu-verification.json`: application version 1, DFU 0.5, device type `0x52`, SoftDevice requirement `0xB6`, application bytes 155024, HEX bounds `0x26000..0x4bd90`.
- Binary hashes are in `artifacts/task-verification/SHA256SUMS`. Package dependencies were installed in a temporary system directory and removed; no virtual environment or `__pycache__` is delivered as evidence.

## Localization

`web/i18n.js` with `web/locales/en.js` and `web/locales/ru.js` provides `t`, `setLanguage`, `getLanguage`, `subscribeLanguage` and `initI18n({selector})`; the compact selector is `#language-select` with `en`/`ru`. Browser preference is used when no stored preference exists, English is the fallback, and the choice persists in `localStorage` under `eink-studio-language`. UI strings, errors and accessible names are tagged explicitly in markup; no reverse text mapping remains. `web/ble.js`, `web/legacy-dfu.js`, `web/ota.js` and `web/text.js` report localized errors. Translation coverage is exercised by parity tests and by the browser switch/persistence checks.

Because `ble.js` now imports `i18n.js`, `docs/protocol-v2.md` states the current integration dependency set: `web/ble.js`, `web/image.js`, `web/i18n.js`, `web/locales/en.js` and `web/locales/ru.js`. Its public `BleTransport` API is unchanged.

## Removed brittle tests

Wording-only assertions that pinned specific English messages were removed from `tests/ota.test.js`, `tests/ble.test.js`, `tests/ble-v2-client.test.js` and `tests/legacy-dfu.test.js`, keeping state, error-code, control-opcode and side-effect assertions. UI checks that depended on incidental label text were replaced by semantic assertions in `tests/ui.test.js`.

## Limitations and unverified behavior

- No physical board was available. Radio, BLE stack timing, display refresh, electrical behavior, panel wiring and real flash endurance were not tested.
- The installed nice!nano/Adafruit bootloader version, its erase policy and its handling of the `0xCC000..0xEC000` region during UF2 or BLE OTA are not established. Excluding bytes from the payload does not prove retention. Back up pages before any firmware update and retain USB recovery.
- The legacy DFU 0.5 package carries CRC16 metadata only and is not cryptographically signed.
- Host flash tests use a simulated flash with plausible failure points; they do not measure real erase/program latency, power loss or wear.
- The page protocol supports one connected central because of the pinned `Bluefruit.begin()` defaults. Supporting multiple centrals would require per-connection ownership of the shared READ characteristic first.
- Browser checks use simulated GATT; Chromium Web Bluetooth behavior against real hardware, MTU negotiation and OS-level permissions were not exercised.
- No push, tag, release, publication or device flashing was performed during the verification phase. The subsequent user request authorizes an ordinary push of `feature/pages-notebook` as package version 1.1.0; no tag or release is authorized. `package.json` and `package-lock.json` carry SemVer 1.1.0; legacy DFU `application_version: 1` remains a separate uint32 and does not encode SemVer. The commit hash and push result will be reported in the final chat.