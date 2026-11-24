import assert from 'node:assert/strict';
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

  console.log('EffectsBrowser.verify: ok (5 compact sub-tabs)');
} finally {
  await vite.close();
}
