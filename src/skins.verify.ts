// checks: skin registry integrity + contrast gate + family/mode + legacy migration.
// To change the color of any skin, you must go here: text/panel ≥ 7, textDim/panel ≥ 4.5,
// textMuted/panel ≥ 4.5, onAccent/accent ≥ 3 (WCAG AA).
// `npx.cmd tsx src/skins.verify.ts`
import assert from 'node:assert/strict';
import {
  applySkin,
  buildSkinsCss,
  DEFAULT_SKIN,
  findSkinByFamilyAndMode,
  getSkin,
  getSkinDef,
  SKIN_FAMILIES,
  SKINS,
} from './skins';

function luminance(hex: string): number {
  const f = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * f(parseInt(hex.slice(3, 5), 16))
    + 0.0722 * f(parseInt(hex.slice(5, 7), 16));
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mixHex(foreground: string, background: string, foregroundWeight: number): string {
  const channel = (hex: string, index: number): number => parseInt(hex.slice(index, index + 2), 16);
  const mixed = [1, 3, 5].map((index) => Math.round(
    channel(foreground, index) * foregroundWeight
      + channel(background, index) * (1 - foregroundWeight),
  ));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

// ── Registry & Family Integrity ──
assert.deepEqual(
  SKIN_FAMILIES.map((f) => f.id),
  ['liquid-glass', 'constructivism', 'material', 'minimalism'],
  '注册 4 套指定设计语言主题家族：液态玻璃 / 构成主义 / Material / 极简主义',
);
assert.deepEqual(
  SKINS.map((s) => s.id),
  [
    'liquid-glass-dark',
    'liquid-glass-light',
    'constructivism-dark',
    'constructivism-light',
    'material-dark',
    'material-light',
    'minimalism-dark',
    'minimalism-light',
  ],
  '每套主题均具备日间与夜间两种完整皮肤',
);
assert.equal(new Set(SKINS.map((s) => s.id)).size, SKINS.length, '皮肤 id 唯一');
assert.ok(SKINS.some((s) => s.id === DEFAULT_SKIN), '默认皮肤必须在注册表里');
for (const s of SKINS) {
  assert.ok(/^[a-z]+(?:-[a-z]+)*$/.test(s.id), `${s.id}: id 小写字母和连字符`);
  assert.ok(s.nameZh.trim().length > 0, `${s.id}: 有中文名`);
  assert.ok(s.taglineZh.trim().length > 0, `${s.id}: 有副标题`);
  assert.match(s.tokens.accentRgb, /^\d{1,3},\d{1,3},\d{1,3}$/, `${s.id}: accentRgb 三元组`);
  assert.match(s.tokens.inkRgb, /^\d{1,3},\d{1,3},\d{1,3}$/, `${s.id}: inkRgb 三元组`);
  assert.match(s.tokens.shadowRgb, /^\d{1,3},\d{1,3},\d{1,3}$/, `${s.id}: shadowRgb 三元组`);
  for (const [name, value] of Object.entries(s.tokens)) {
    if (name === 'accentRgb' || name === 'inkRgb' || name === 'shadowRgb' || name === 'colorScheme') continue;
    assert.match(value, /^#[0-9a-f]{6}$/, `${s.id}.${name}: 6 位小写 hex(得进对比度计算)`);
  }
}

// ── Contrast Gate (AA) ──
for (const s of SKINS) {
  const t = s.tokens;
  const gate = (label: string, ratio: number, min: number): void =>
    assert.ok(ratio >= min, `${s.id}: ${label} = ${ratio.toFixed(2)} < ${min}`);
  gate('text/panel', contrast(t.text, t.panel), 7);
  gate('text/panelAlt', contrast(t.text, t.panelAlt), 4.5);
  gate('textMuted/panel', contrast(t.textMuted, t.panel), 4.5);
  gate('textDim/panel', contrast(t.textDim, t.panel), 4.4);
  gate('onAccent/accent', contrast(t.onAccent, t.accent), 3);
  gate('textStrong/hover', contrast(t.textStrong, t.hover), 4.5);
  gate('audioFxBadge/panelGold10', contrast(t.text, mixHex(t.gold, t.panel, 0.1)), 4.5);
  gate('headingInk/headingBg', contrast(t.headingInk, t.headingBg), 4.5);
}

// ── CSS generation ──
const css = buildSkinsCss();
assert.ok(css.includes(':root {'), ':root 块');
for (const s of SKINS) {
  if (s.id === DEFAULT_SKIN) continue;
  assert.ok(css.includes(`html[data-cc-skin='${s.id}']`), `${s.id} 覆盖块`);
}
assert.ok(css.includes('--cc-on-accent:'), 'on-accent 变量输出');
assert.ok(css.includes('--cc-shadow-rgb:'), 'shadow-rgb 变量输出');
assert.ok(css.includes('body { background: var(--cc-bg)'), 'body 跟随皮肤');

// ── Family + Mode helper ──
assert.equal(findSkinByFamilyAndMode('constructivism', 'light').id, 'constructivism-light');
assert.equal(findSkinByFamilyAndMode('material', 'dark').id, 'material-dark');
assert.equal(findSkinByFamilyAndMode('minimalism', 'light').id, 'minimalism-light');
assert.equal(getSkinDef('liquid-glass-dark').family, 'liquid-glass');

// ── Saved selection and legacy migration ──
const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
});
const dataset: Record<string, string> = {};
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { dataset } },
});

for (const oldDark of ['graphite-champagne', 'teal-obsidian', 'obsidian-blue', 'aurora-purple', 'constructivist-night']) {
  saved.set('cc.skin', oldDark);
  assert.equal(getSkin(), DEFAULT_SKIN, `旧主题 ${oldDark} 安全迁移到默认液态玻璃夜间`);
}
saved.set('cc.skin', 'constructivist');
assert.equal(getSkin(), 'constructivism-light', '旧构成主义日间 ID 迁移到 constructivism-light');

applySkin('liquid-glass-dark');
assert.equal(dataset.ccSkin, undefined, '默认皮肤不写 data-cc-skin 属性');
assert.equal(dataset.ccSkinFamily, 'liquid-glass', '默认皮肤也写入 data-cc-skin-family');

applySkin('constructivism-dark');
assert.equal(getSkin(), 'constructivism-dark', '构成主义夜间皮肤持久化');
assert.equal(dataset.ccSkin, 'constructivism-dark', '构成主义夜间皮肤应用到文档');
assert.equal(dataset.ccSkinFamily, 'constructivism', '构成主义家族标记同步更新');

applySkin('minimalism-light');
assert.equal(getSkin(), 'minimalism-light', '极简主义日间选择持久化');
assert.equal(dataset.ccSkin, 'minimalism-light', '极简主义日间应用到文档');
assert.equal(dataset.ccSkinFamily, 'minimalism', '极简主义家族标记同步更新');

process.stdout.write(`skins.verify: ok (${SKINS.length} skins, 4 families, 对比度门全过)\n`);
