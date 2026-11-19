import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleUrl = new URL('./window-frame.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop window frame policy must be independently testable');

if (existsSync(moduleUrl)) {
  const { applyDesktopWindowFrame, desktopWindowFrameOptions, resolveTitlebarAppearance } = await import(moduleUrl.href);
  assert.deepEqual(
    desktopWindowFrameOptions('darwin'),
    { titleBarStyle: 'hiddenInset' },
    'macOS reserves an inset titlebar region for renderer controls',
  );
  assert.deepEqual(desktopWindowFrameOptions('win32'), { titleBarStyle: 'hidden', titleBarOverlay: { color: '#fffdf8', symbolColor: '#28241d', height: 52 }, autoHideMenuBar: true }, 'Windows starts with a matching light titlebar and native buttons');
  assert.deepEqual(resolveTitlebarAppearance({ color: '#000000', symbolColor: '#fff6d2', height: 52 }, 1.1), { color: '#000000', symbolColor: '#fff6d2', height: 57 });
  for (const invalid of [null, {}, { color: 'red', symbolColor: '#ffffff', height: 52 }, { color: '#000000', symbolColor: '#ffffff', height: NaN }, { color: '#000000', symbolColor: '#ffffff', height: 900 }]) assert.equal(resolveTitlebarAppearance(invalid, 1), null);
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
