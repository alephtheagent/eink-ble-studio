# Vendored libraries

All third-party code used by the OTA firmware updater is committed here. Nothing is
loaded from a CDN at runtime; `web/index.html` references these files with relative
`src` paths only.

Each bundle is a UMD build that attaches a global. They are loaded as classic
`<script>` tags at the end of `<body>`, before `app.js`:

| File | Package | Version | Global | License |
| --- | --- | --- | --- | --- |
| `jszip.min.js` | [jszip](https://github.com/Stuk/jszip) | 3.10.1 | `window.JSZip` | dual MIT / GPLv3 (see `jszip.min.js.LICENSE`) |
| `crc32.js` | [crc-32](https://github.com/SheetJS/js-crc32) | 1.2.2 | `window.CRC32` (`CRC32.buf(Uint8Array)`) | Apache-2.0 (see `crc32.js.LICENSE`) |
| `secure-dfu.js` | [web-bluetooth-dfu](https://github.com/thegecko/web-bluetooth-dfu) | 1.2.1 | `window.SecureDfu` | MIT (see `secure-dfu.js.LICENSE`) |

## Source and integrity

Downloaded from npm via unpkg once; `sha384` values below are the SRI hashes of the
committed files (verify with `sha384sum <file>`):

```
1422ae376aa1907d234d95cc960c73513ceea2a257a99a97892741ca9711d57f58510503407d73c6aca63561a8f47f86  secure-dfu.js
fa66d5d88635664fd7d69fe75a5946c9225250df2e32cfa0500375d0eafde54047d1fa63e867ca80f9a00b911789e5c6  jszip.min.js
7ff1aab8d88f24bbf7ab74482c497e350af79437853116f308667342fdc81ed377bbcf014209269be3d799ebd4534600  crc32.js
```

| File | Source URL |
| --- | --- |
| `secure-dfu.js` | https://unpkg.com/web-bluetooth-dfu@1.2.1/dist/secure-dfu.js |
| `jszip.min.js` | https://unpkg.com/jszip@3.10.1/dist/jszip.min.js |
| `crc32.js` | https://unpkg.com/crc-32@1.2.2/crc32.js |
| `jszip.min.js.LICENSE` | https://unpkg.com/jszip@3.10.1/LICENSE.markdown |
| `crc32.js.LICENSE` | https://unpkg.com/crc-32@1.2.2/LICENSE |
| `secure-dfu.js.LICENSE` | https://unpkg.com/web-bluetooth-dfu@1.2.1/LICENSE |

## Usage notes

- `SecureDfu` constructor: `new SecureDfu(crc32, bluetooth, delayMs)`; `update(device,
  initPacketArrayBuffer, firmwareArrayBuffer)` returns a promise; listen to
  `SecureDfu.EVENT_LOG` and `SecureDfu.EVENT_PROGRESS` for log/progress events.
- `web/ota.js` reads the globals lazily inside functions and reports
  `OtaError('LIBS_MISSING')` if a bundle failed to load.
- The controller validates ZIPs with JSZip even when tests inject a DFU backend.
  It accepts application-only Secure DFU manifests, not legacy DFU 0.5 packages.
