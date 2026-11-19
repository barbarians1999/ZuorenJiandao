import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const localeId = '\0panel-divider-test-locale';
const vite = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: 'panel-divider-test-locale',
    enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) { return id === localeId ? 'export const t = (text) => text; export const useT = () => t;' : null; },
  }],
});

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
});

try {
  const [{ useEditorPanelLayout }, { Divider }] = await Promise.all([
    vite.ssrLoadModule('/src/hooks/useEditorPanelLayout.ts'),
    vite.ssrLoadModule('/src/components/Divider.tsx'),
  ]);
  function RenderSplitters() {
    const layout = useEditorPanelLayout();
    return createElement('div', null,
      createElement(Divider, { onResize() {}, ariaValue: layout.librarySize, ariaValueLabel: '媒体库宽度' }),
      createElement(Divider, { orientation: 'horizontal', onResize() {}, ariaValue: layout.timelineSize, ariaValueLabel: '时间线高度' }),
    );
  }
  function dividerValues(markup: string) {
    return [...markup.matchAll(/<div class="cc-panel-divider[^>]*aria-valuenow="([^"]+)" aria-valuemin="([^"]+)" aria-valuemax="([^"]+)" aria-valuetext="([^"]+)"/g)]
      .map((match) => ({ value: Number(match[1]), min: Number(match[2]), max: Number(match[3]), text: match[4] }));
  }
  const initial = renderToStaticMarkup(createElement(RenderSplitters));
  const initialValues = dividerValues(initial);
  assert.equal(initialValues.length, 2);
  assert.equal(initialValues[0]?.value, (406 / 1463) * 100);
  assert.equal(initialValues[0]?.min, (260 / 1463) * 100);
  assert.equal(initialValues[0]?.max, (1 - 360 / 1463) * 100);
  assert.equal(initialValues[0]?.text, '媒体库宽度 27.8%');
  assert.match(initial, /aria-orientation="vertical" aria-label=/);
  assert.match(initial, /aria-orientation="horizontal" aria-label=/);
  assert.equal(initialValues[1]?.value, (350 / 761) * 100);
  assert.equal(initialValues[1]?.min, (260 / 761) * 100);
  assert.equal(initialValues[1]?.max, (1 - 300 / 761) * 100);
  assert.equal(initialValues[1]?.text, '时间线高度 46%');

  storage.set('openchatcut.libraryRatio.ui-v3', JSON.stringify(0.7));
  storage.set('openchatcut.timelineRatio.ui-v2', JSON.stringify(0.6));
  const largerTimeline = renderToStaticMarkup(createElement(RenderSplitters));
  const largerValues = dividerValues(largerTimeline);
  assert.equal(largerValues[0]?.value, 70);
  assert.equal(largerValues[0]?.text, '媒体库宽度 70%');
  assert(largerValues[1]!.value > initialValues[1]!.value, 'larger bottom timeline ratio reports a larger value');
  assert.equal(largerValues[1]?.text, '时间线高度 60%');

  storage.set('openchatcut.libraryRatio.ui-v3', JSON.stringify(-1));
  storage.set('openchatcut.timelineRatio.ui-v2', JSON.stringify(2));
  const clamped = renderToStaticMarkup(createElement(RenderSplitters));
  const clampedValues = dividerValues(clamped);
  assert.equal(clampedValues[0]?.value, clampedValues[0]?.min);
  assert.equal(clampedValues[1]?.value, clampedValues[1]?.max);

  storage.set('openchatcut.libraryRatio.ui-v3', 'null');
  storage.set('openchatcut.timelineRatio.ui-v2', 'null');
  const nonfinite = dividerValues(renderToStaticMarkup(createElement(RenderSplitters)));
  assert.equal(nonfinite[0]?.value, initialValues[0]?.value);
  assert.equal(nonfinite[1]?.value, initialValues[1]?.value);
  console.log('editor splitter ARIA values, bounds, labels, and clamping verified');
} finally {
  await vite.close();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}
