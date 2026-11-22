import en from './locales/en.js';
import ru from './locales/ru.js';

export const messages = Object.freeze({ en, ru });
export const LANGUAGE_STORAGE_KEY = 'eink-studio-language';
const SUPPORTED = new Set(['en', 'ru']);
let language = 'en';
const listeners = new Set();
let initialized = false;

function normalizeLanguage(value) {
  const code = String(value || '').trim().toLowerCase().split(/[-_]/, 1)[0];
  return SUPPORTED.has(code) ? code : null;
}
function browserLanguage() {
  const candidates = globalThis.navigator?.languages?.length ? globalThis.navigator.languages : [globalThis.navigator?.language];
  for (const candidate of candidates || []) {
    const supported = normalizeLanguage(candidate);
    if (supported) return supported;
  }
  return 'en';
}
function interpolate(value, vars) {
  return value.replace(/\{([A-Za-z0-9_.-]+)\}/g, (token, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : token);
}
export function t(key, vars = {}) {
  const value = messages[language][key] ?? messages.en[key] ?? key;
  return interpolate(value, vars);
}

function applyElement(element) {
  const textKey = element.getAttribute('data-i18n');
  if (textKey !== null) element.textContent = t(textKey);
  for (const [attribute, keyName] of [
    ['title', 'data-i18n-title'], ['aria-label', 'data-i18n-aria-label'], ['placeholder', 'data-i18n-placeholder']
  ]) {
    const key = element.getAttribute(keyName);
    if (key !== null) element.setAttribute(attribute, t(key));
  }
}
export function applyTranslations(root = globalThis.document) {
  if (!root) return;
  if (root.nodeType === 1) applyElement(root);
  root.querySelectorAll?.('[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]')
    .forEach(applyElement);
  if (root.documentElement) root.documentElement.lang = language;
}

export function setLanguage(value) {
  const next = normalizeLanguage(value);
  if (!next) throw new RangeError(`Unsupported language: ${value}`);
  if (next === language) return language;
  language = next;
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Storage may be disabled. */ }
  applyTranslations();
  for (const listener of [...listeners]) listener(language);
  return language;
}
export function getLanguage() { return language; }
export function subscribeLanguage(listener) {
  if (typeof listener !== 'function') throw new TypeError('Language listener must be a function');
  listeners.add(listener);
  listener(language);
  return () => listeners.delete(listener);
}

export function initI18n({ selector } = {}) {
  const preferred = (() => {
    try { return normalizeLanguage(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)); }
    catch { return null; }
  })() || browserLanguage();
  language = preferred;
  applyTranslations();
  let control = selector;
  if (typeof control === 'string') control = globalThis.document?.querySelector(control);
  if (control) {
    control.value = language;
    control.addEventListener('change', () => {
      const selected = normalizeLanguage(control.value);
      if (selected) setLanguage(selected);
      else control.value = language;
    });
  }
  if (!initialized && globalThis.MutationObserver && globalThis.document?.documentElement) {
    initialized = true;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1) applyTranslations(node);
      }
    }).observe(globalThis.document.documentElement, { childList: true, subtree: true });
  }
  for (const listener of [...listeners]) listener(language);
  return language;
}
