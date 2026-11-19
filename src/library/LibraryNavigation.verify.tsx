import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const localeId = '\0library-navigation-locale';
const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null }, plugins: [{
  name: 'navigation-test-locale', enforce: 'pre',
  resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
  load(id) { return id === localeId ? 'export const useT = () => (text) => text;' : null; },
}] });
try {
  const { LibraryNavigation, LIBRARY_TOOLS, isResourceTool } = await vite.ssrLoadModule('/src/library/LibraryNavigation.tsx');
  assert.deepEqual(LIBRARY_TOOLS.map((tool: { id: string }) => tool.id),
    ['我的素材', '特效', '背景音乐', '字幕', '插入文字', '音效', '序列', '扩展中心']);
  for (const tool of LIBRARY_TOOLS) {
    const html = renderToStaticMarkup(createElement(LibraryNavigation, { active: tool.id, onSelect() { throw new Error('render must not select'); } }));
    assert.equal((html.match(/<button/g) ?? []).length, 8);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(html, /<nav[^>]+aria-label="资源库"/);
    assert.match(html, /子草稿/);
    assert.doesNotMatch(html, /标题动画|LUT|缩放|转场/);
    assert.doesNotMatch(html, /更多工具/);
    assert.equal(isResourceTool(tool.id), tool.id === '音效');
  }
  const panel = await readFile(new URL('./LibraryPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<LibraryNavigation/);
  assert.doesNotMatch(panel, /advancedOpen/);
  const utilities = await readFile(new URL('../components/ToolbarUtilities.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(utilities, /onClickCapture/, 'closing a disclosure must not intercept child activation');
  assert.match(utilities, /event\.key === 'Escape'/);
  const css = await readFile(new URL('../index.css', import.meta.url), 'utf8');
  assert.match(css, /@container library-content \(max-width:320px\)/, 'resource layout responds to content width excluding the rail');
  console.log('library first-level navigation and utility disclosure verified');
} finally { await vite.close(); }
