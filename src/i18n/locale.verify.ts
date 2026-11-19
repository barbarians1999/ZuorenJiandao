import assert from 'node:assert/strict';

const documentElement = { lang: 'en' };
let stored = 'ru';
const writes: string[] = [];
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => stored,
    setItem: (key: string, value: string) => { stored = value; writes.push(`${key}:${value}`); },
  },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const { getLocale, localeLanguageName } = await import('./locale.ts');
assert.equal(getLocale(), 'zh');
assert.equal(localeLanguageName(), '中文');
assert.equal(stored, 'zh', 'legacy locale preferences migrate to Chinese');
assert.ok(writes.includes('cc.locale:zh'));
assert.equal(documentElement.lang, 'zh-CN');

console.log('locale.verify: legacy preferences always resolve to Chinese');
