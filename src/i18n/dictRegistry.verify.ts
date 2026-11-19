import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'en', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { lang: 'zh-CN' } },
});

const { ensureLocaleDict, getLocale, t, tData } = await import('./locale.ts');
assert.equal(getLocale(), 'zh');
await ensureLocaleDict('zh');
assert.equal(t('导出'), '导出', 'Chinese source text is the interface copy');
assert.equal(t('已选 {n} 项', { n: 3 }), '已选 3 项');
assert.equal(tData('Bar Chart - Annual Sales'), '柱状图 · 年度销售');
assert.equal(tData('Simple Whoosh'), '简洁呼啸');
assert.equal(tData('我的自定义素材'), '我的自定义素材');

console.log('dictRegistry.verify: Chinese UI and legacy catalog-name compatibility passed');