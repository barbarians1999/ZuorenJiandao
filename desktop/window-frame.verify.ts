import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleUrl = new URL('./window-frame.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop window frame policy must be independently testable');

if (existsSync(moduleUrl)) {
  const { applyDesktopWindowFrame, desktopWindowFrameOptions } = await import(moduleUrl.href);
  assert.deepEqual(
    desktopWindowFrameOptions('darwin'),
    { titleBarStyle: 'hiddenInset' },
    'macOS reserves an inset titlebar region for renderer controls',
  );
  assert.deepEqual(desktopWindowFrameOptions('win32'), { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161a', symbolColor: '#e6e6e8', height: 36 }, autoHideMenuBar: true }, 'Windows keeps native caption buttons over a dark overlay and hides the menu row');
  assert.deepEqual(desktopWindowFrameOptions('linux'), {}, 'Linux keeps its native frame');

  const visibilityCalls: boolean[] = [];
  let menuCalls = 0;
  applyDesktopWindowFrame({
    setWindowButtonVisibility: (visible: boolean) => visibilityCalls.push(visible),
    setMenu: () => { menuCalls += 1; },
  }, 'darwin');
  assert.deepEqual(visibilityCalls, [false], 'macOS native traffic lights are hidden when renderer controls exist');
  assert.equal(menuCalls, 0, 'macOS application menus remain available');

  applyDesktopWindowFrame({
    setWindowButtonVisibility: (visible: boolean) => visibilityCalls.push(visible),
    setMenu: () => { menuCalls += 1; },
  }, 'win32');
  assert.deepEqual(visibilityCalls, [false], 'non-macOS platforms do not call macOS window APIs');
  assert.equal(menuCalls, 1, 'Windows removes the native menu row instead of merely auto-hiding it');
}

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(mainSource, /openchatcut:window-action/, 'main process must register window actions');

console.log('desktop window-frame verification passed');
