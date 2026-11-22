# Additive UI verification report

## Scope and result

The worktree's original `web/` snapshot was preserved before application edits at `scratch/baseline/web/` and served separately at `http://127.0.0.1:8765/`. The final worktree was served at `http://127.0.0.1:8766/`. No application web files were edited by this test/harness work.

No actionable application defect was observed in the checks below. The established menus and old image workflow remain usable; the original 122×250 canvases are unchanged. The unobtrusive **Add text** toolbar action is the visible default-screen addition. The text controls remain hidden until used. At the captured first-view scroll position the 390×844 screenshots preserve the original screen composition.

## Verification

- `npm test` — **pass**: 25 JavaScript tests passed; the C++ shared CRC/pixel/protocol suite passed.
- Firefox smoke (Playwright Firefox, headless):
  - `PLAYWRIGHT_BROWSERS_PATH=/home/aleph/.hermes/cache/scratch/eink-studio-browsers STUDIO_URL=http://127.0.0.1:8766/ node tools/smoke_firefox.js`
  - **pass** at 1280×900, 390×844, and 320×740: approved reference frame byte-exact; keyboard, menus, local file open, no horizontal overflow, no page errors.
- Additional Firefox workflows:
  - `PLAYWRIGHT_BROWSERS_PATH=/home/aleph/.hermes/cache/scratch/eink-studio-browsers STUDIO_URL=http://127.0.0.1:8766/ node tools/additive_firefox.js`
  - **pass**: native 122×250 resolution, pointer pan, tiling and gray-gradient threshold changes, fine image rotation/undo, text-only transfer through a v1 mock GATT connection, and touch-typed pinch simulation (eight equal-distance moves do not resize; a 20% spread advances text size one step).
- `tests/ui.test.js` now asserts a text-composed frame is 4000 bytes with six zero padding bits per row, its preview and downloaded PNG pixels equal the exported frame, opacity 0 restores the pre-text image frame, overlapping black/white layers produce different pixels when reordered, and undo/redo restore the exact corresponding frames. The harness decodes the application's embedded reference data URL and renders font preview canvases with the real canvas backend.
- `tests/ble.test.js` covers capability-present v2 GATT discovery, exact decoded raw and PackBits payloads (including CRC and write ceiling), and v1 discovery/fallback when capabilities are absent. The Firefox mock-send test compares the actual app's sent 4000-byte payload byte-for-byte with the frame downloaded from that same text-only composition.

## Screenshots

The pristine baseline and final screenshots use Firefox at the same viewport sizes, the approved reference image where applicable, and `scrollY=0`:

- Pristine original first screen: `scratch/baseline/original-first-desktop.png`, `scratch/baseline/original-first-mobile.png`, `scratch/baseline/original-first-narrow.png`
- Pristine reference loaded, aligned to top: `scratch/baseline/opened-top-desktop.png`, `scratch/baseline/opened-top-mobile.png`, `scratch/baseline/opened-top-narrow.png`
- Final first screen: `scratch/final/first-desktop.png`, `scratch/final/first-mobile.png`, `scratch/final/first-narrow.png`
- Final reference loaded: `scratch/final/reference-desktop.png`, `scratch/final/reference-mobile.png`, `scratch/final/reference-narrow.png`
- Expanded Russian text controls and successful mock send: `scratch/final/text-send-touch-firefox.png`
- Expanded font picker with its 13/14/16/20 native-pixel-height groups: `scratch/final/text-font-picker-firefox.png`
- White Russian text over the approved image: `scratch/final/text-overlay-white-viewport.png` (viewport) and `scratch/final/text-overlay-white-desktop.png` (full page)
- Existing smoke full-page screenshots and machine results: `artifacts/editor-{desktop,mobile,narrow}.png`, `artifacts/firefox-smoke.json`

The baseline and final first-screen captures match in the preserved menu, image panel, canvas size/placement, and initial controls. With the approved image loaded, the final Image toolbar adds only the text action; the old reference, save, rotate, reset, and image-open controls remain. No horizontal overflow was observed at any tested width.

## Limits

Firefox Bluetooth is unavailable natively; the app's v1 send path was exercised using a mock GATT device. The v2 transport was exercised with a protocol-aware GATT mock in Node tests. No physical display, radio, firmware, or hardware behavior was tested or claimed. Touch/pinch uses synthetic Firefox pointer events tagged `pointerType: touch` (with pointer capture stubbed for those synthetic events); this is not a physical touchscreen test.