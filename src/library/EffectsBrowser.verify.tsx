import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const localeId = '\0effects-browser-locale';
const vite = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: 'effects-browser-test-locale',
    enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) { return id === localeId ? 'export const useT = () => (text) => text;' : null; },
  }],
});

try {
  const { EffectsBrowser } = await vite.ssrLoadModule('/src/library/EffectsBrowser.tsx');
  for (const subTab of ['fx', 'lut', 'transition', 'zoom', 'shapes'] as const) {
    const html = renderToStaticMarkup(createElement(EffectsBrowser, {
      defaultSubTab: subTab,
      selectedItem: {
        id: 'clip-1',
        name: 'clip-1',
        kind: 'video',
        track: 'V1',
        startFrame: 0,
        durationInFrames: 60,
      },
      onAddShape: () => undefined,
      onAddSolid: () => undefined,
      onAddMosaic: () => undefined,
      onApplyFx: () => undefined,
      onApplyTransition: () => undefined,
      onApplyZoom: () => undefined,
    }));
    assert.ok(!html.includes('所有画面特效、LUT、转场与遮罩马赛克均处于字幕轨下方'), '已移除冗余的常驻特效文字说明');
    assert.match(html, /role="tablist"/);
    assert.match(html, /画面特效/);
    assert.match(html, /滤镜 LUT/);
    assert.match(html, /转场/);
    assert.match(html, /推拉缩放/);
    assert.match(html, /形状与马赛克/);
  }

  const defaultHtml = renderToStaticMarkup(createElement(EffectsBrowser, {
    onAddShape: () => undefined,
    onAddSolid: () => undefined,
    onAddMosaic: () => undefined,
  }));
  assert.ok(
    defaultHtml.indexOf('形状与马赛克') < defaultHtml.indexOf('画面特效'),
    '形状与马赛克应排在特效子分页第一位',
  );
  assert.match(defaultHtml, /aria-selected="true"[^>]*>形状与马赛克</, '特效面板默认选中形状与马赛克');
  assert.doesNotMatch(defaultHtml, /cc-effect-card-hint/, '卡片内不应再渲染底部小字说明');
  assert.doesNotMatch(defaultHtml, /cc-effect-card-wide/, '高斯模糊卡片应与形状卡片保持统一栅格样式');
  for (const label of ['矩形', '椭圆', '纯色背景', '高斯模糊（马赛克）']) {
    assert.ok(
      defaultHtml.includes(`</div><span class="cc-effect-card-label">${label}</span>`),
      `卡片文字“${label}”应位于缩略图方框外部下方`,
    );
  }

  const [polishCss, skinCss] = await Promise.all([
    readFile(new URL('../editor/editor-ui-polish.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/skin-themes.css', import.meta.url), 'utf8'),
  ]);
  assert.match(polishCss, /\.cc-editor-shell\s+\.cc-effect-card\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s, '外层卡片按钮应透明无边框，仅缩略图框保留底色');
  assert.doesNotMatch(skinCss, /constructivism[\s\S]*?\.cc-effect-card\s*\)/, '构成主义皮肤边框应仅作用于缩略图框而非整张卡片');
  assert.match(skinCss, /\.cc-effect-card-thumb\s*\)\s*\{\s*border:\s*1px solid var\(--cc-border\)/s, '构成主义皮肤应对缩略图框描边');

  console.log('EffectsBrowser.verify: ok (5 compact sub-tabs, external card labels)');
} finally {
  await vite.close();
}
