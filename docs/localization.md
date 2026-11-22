# Localization

The local UI is English (`en`) and Russian (`ru`). There are no external translation dependencies or CDN assets.

## API

Import from `web/i18n.js`:

```js
import { t, setLanguage, getLanguage, subscribeLanguage, initI18n } from './i18n.js';
initI18n({ selector: '#language-select' });
```

`initI18n` selects a valid saved preference first (`localStorage` key `eink-studio-language`), otherwise searches `navigator.languages`/`navigator.language` for `ru` or `en`, and falls back to English. It synchronizes the selector and the document root `lang`. The selector is a `<select id="language-select">` with `en` and `ru` option values. `setLanguage('en'|'ru')` updates persistence (when storage is available), translated DOM, and listeners; unsupported values throw `RangeError`. `getLanguage()` returns the active two-letter code. `subscribeLanguage(fn)` immediately calls the function with current language and returns an unsubscribe function. `t(key, vars)` reads a flat dot-key message and replaces `{placeholder}` tokens with supplied values; unknown keys fall back to English and then to the key itself. `messages` exports both dictionaries for completeness/placeholder tests; `applyTranslations(root)` is available to refresh a subtree.

## DOM contract

Add translation keys to the owned dictionaries in both languages. Static content may use:

- `data-i18n="key"` to set an element's text content
- `data-i18n-title="key"` to set `title`
- `data-i18n-aria-label="key"` to set `aria-label`
- `data-i18n-placeholder="key"` to set `placeholder`

The module translates tagged elements present on init and tagged nodes subsequently inserted into the document. Attribute translation preserves form values and other attributes. Do not translate source strings by matching rendered English text: it is ambiguous for nested elements, user-provided text and filenames. Runtime status, error, confirmation and generated text must call `t(key, vars)` when generated; DOM attributes cannot replace those calls. Avoid caching translated strings across language changes; re-render dynamic content from the listener or at its update point.
New text layers use translated sample text (`text.sampleContent`), but changing languages never rewrites existing layer content, imported project data, layer names, filenames or other user data. The bundled fonts include all basic Russian letters (including Ё/ё); unsupported glyphs are left visible through the localized missing-glyph warning rather than silently replaced. Project import validates font IDs against the bundled font list before passing state to the editor.

## Message coverage

BLE error messages and legacy-DFU first-party failures are localized as well. `BleTransport` imports `t()` and translates validation, protocol acknowledgements, numeric device error statuses, disconnection, timeouts and stage wrappers while retaining `cause`, timeout flags and error markers. The classic `LegacyDfu` constructor accepts optional `translate(key, vars)` injection; standalone classic-script consumers default to English, while OTA injects the module translator. Native browser/OS GATT failures remain available as the original detail interpolated inside the localized stage message. Error codes and transport behavior are unchanged.
