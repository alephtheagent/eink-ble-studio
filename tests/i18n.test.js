import test from 'node:test';
import assert from 'node:assert/strict';
import en from '../web/locales/en.js';
import ru from '../web/locales/ru.js';
import { JSDOM } from 'jsdom';
import { initI18n, setLanguage, getLanguage, subscribeLanguage, LANGUAGE_STORAGE_KEY, t } from '../web/i18n.js';

const placeholders = value => [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
test('English and Russian catalogs are complete and use identical interpolation parameters', () => {
  const keys = Object.keys(en).sort();
  assert.ok(keys.length > 0);
  assert.deepEqual(Object.keys(ru).sort(), keys);
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof ru[key], 'string', key);
    assert.ok(en[key].trim(), key);
    assert.ok(ru[key].trim(), key);
    assert.deepEqual(placeholders(ru[key]), placeholders(en[key]), key);
  }
});


test('browser preference, switching, subscription, persistence and fallback', () => {
  const dom = new JSDOM('<!doctype html><html><body><select id="language-select"><option value="en">English</option><option value="ru">Русский</option></select></body></html>', {url:'http://localhost/'});
  const old = {document:globalThis.document, navigator:globalThis.navigator, localStorage:globalThis.localStorage};
  try {
    Object.defineProperty(globalThis, 'document', {value:dom.window.document, configurable:true});
    Object.defineProperty(globalThis, 'navigator', {value:{languages:['fr-FR','ru-RU']}, configurable:true});
    Object.defineProperty(globalThis, 'localStorage', {value:dom.window.localStorage, configurable:true});
    const select = dom.window.document.querySelector('#language-select');
    assert.equal(initI18n({selector:select}), 'ru');
    assert.equal(select.value, 'ru');
    const calls=[]; const unsubscribe=subscribeLanguage(lang=>calls.push(lang));
    select.value='en'; select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(getLanguage(),'en'); assert.equal(localStorage.getItem(LANGUAGE_STORAGE_KEY),'en');
    assert.deepEqual(calls,['ru','en']); unsubscribe();
    setLanguage('ru'); assert.deepEqual(calls,['ru','en']);
    assert.equal(initI18n(), 'ru');
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    Object.defineProperty(globalThis,'navigator',{value:{languages:['fr-FR']},configurable:true});
    assert.equal(initI18n(), 'en');
    assert.equal(t('unknown.test.key'), 'unknown.test.key');
  } finally {
    for (const [key,value] of Object.entries(old)) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    dom.window.close();
  }
});