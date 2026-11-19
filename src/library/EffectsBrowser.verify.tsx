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
  const expectedNote = '所有画面特效、LUT、转场与遮罩马赛克均处于字幕轨下方，不会遮挡或染色上方字幕。';

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
    assert.ok(html.includes(expectedNote), `${subTab} 子标签页必须明确提示位于字幕轨下方`);
    assert.match(html, /role="tablist"/);
    assert.match(html, /画面特效/);
    assert.match(html, /滤镜 LUT/);
    assert.match(html, /转场/);
    assert.match(html, /推拉缩放/);
    assert.match(html, /形状与马赛克/);
  }

  console.log('EffectsBrowser.verify: ok (5 sub-tabs & below-caption guardrail note)');
} finally {
  await vite.close();
}
