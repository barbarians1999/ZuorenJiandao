import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const controlsUrl = new URL('./DesktopWindowControls.tsx', import.meta.url);
assert.equal(existsSync(controlsUrl), true, 'renderer window controls must exist before native controls are hidden');

if (existsSync(controlsUrl)) {
  const { DesktopWindowControlButtons } = await import(controlsUrl.href);
  const actions: string[] = [];
  const html = renderToStaticMarkup(
    <DesktopWindowControlButtons translate={(text: string) => text} onAction={(action: string) => actions.push(action)} />,
  );
  assert.match(html, /aria-label="窗口控制"/);
  assert.equal((html.match(/<button/g) ?? []).length, 3, 'macOS control cluster has three buttons');
  assert.match(html, /aria-label="关闭窗口"/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="缩放窗口"/);
  assert.deepEqual(actions, [], 'rendering controls does not invoke native actions');
}

const topBarSource = readFileSync(new URL('./TopBar.tsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./Dashboard.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
assert.match(topBarSource, /<DesktopWindowControls\s*\/>/, 'editor titlebar includes desktop controls');
assert.match(dashboardSource, /<DesktopWindowControls\s*\/>/, 'dashboard titlebar includes desktop controls');
assert.match(topBarSource, /cc-window-titlebar--windows/, 'editor exposes a Windows titlebar class');
assert.match(dashboardSource, /cc-window-titlebar--windows/, 'dashboard exposes a Windows titlebar class');
assert.match(cssSource, /\.cc-window-titlebar--windows\s*\{[^}]*padding-right:\s*140px[^}]*app-region:\s*drag/s, 'Windows titlebar keeps a draggable region and native-button safe area');
assert.match(cssSource, /app-region:\s*no-drag/, 'interactive titlebar controls remain clickable');
assert.match(readFileSync(controlsUrl, 'utf8'), /platform\s*!==\s*'darwin'/, 'renderer controls stay macOS-only while Windows uses native caption buttons');

console.log('renderer window-titlebar verification passed');
