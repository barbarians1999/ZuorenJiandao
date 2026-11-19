import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const controlsUrl = new URL('./DesktopWindowControls.tsx', import.meta.url);
assert.equal(existsSync(controlsUrl), true, 'renderer window controls must exist before native controls are hidden');

if (existsSync(controlsUrl)) {
  const { DesktopWindowControlButtons, resolveWindowsTitlebarSafeRightPx } = await import(controlsUrl.href);
  assert.equal(resolveWindowsTitlebarSafeRightPx({ outerWidth: 1600, innerWidth: 1455 }), 168);
  assert.ok(
    resolveWindowsTitlebarSafeRightPx({ outerWidth: 1072, innerWidth: 1463 }) >= 218,
    'shrunk desktop windows expand CSS right padding so zoomed-down caption buttons stay clear',
  );
  assert.equal(
    resolveWindowsTitlebarSafeRightPx({ outerWidth: 1600, innerWidth: 1455, overlayRightInsetCss: 192 }),
    210,
    'live windowControlsOverlay width adds an 18px clearance buffer when wider than baseline',
  );
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
assert.match(cssSource, /\.cc-window-titlebar--windows\s*\{[^}]*env\(titlebar-area-width[^}]*app-region:\s*drag/s, 'Windows titlebar reserves the native safe area at custom zoom and stays draggable');
const polishCssSource = readFileSync(new URL('../editor/editor-ui-polish.css', import.meta.url), 'utf8');
assert.doesNotMatch(polishCssSource, /\.cc-editor-shell\s+\.cc-topbar\s*\{[^}]*padding-inline\s*:/s, 'editor polish CSS must not clobber Windows/macOS titlebar safe-area padding with padding-inline');
assert.match(polishCssSource, /\.cc-editor-shell\s+\.cc-topbar\.cc-window-titlebar--windows\s*\{[^}]*env\(titlebar-area-width/s, 'editor topbar preserves the Windows safe area for the export button');
assert.doesNotMatch(topBarSource, /left: '50%'/, 'project name must not overlap actions through absolute centering');
assert.match(readFileSync(controlsUrl, 'utf8'), /setTitlebarAppearance/, 'native buttons follow the renderer theme and height');
assert.match(cssSource, /app-region:\s*no-drag/, 'interactive titlebar controls remain clickable');
assert.match(readFileSync(controlsUrl, 'utf8'), /platform\s*!==\s*'darwin'/, 'renderer controls stay macOS-only while Windows uses native caption buttons');

console.log('renderer window-titlebar verification passed');
