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
assert.match(mainSource, /installDesktopApplicationMenu/, 'main process must install macOS application menu');
assert.match(mainSource, /openchatcut:native-edit/, 'main process must register native-edit IPC handler');

{
  const {
    buildMacApplicationMenuTemplate,
    installDesktopApplicationMenu,
    isNativeEditAction,
    NATIVE_EDIT_ACTIONS,
  } = await import('./app-menu.ts');
  assert.equal(isNativeEditAction('copy'), true);
  assert.equal(isNativeEditAction('selectAll'), true);
  assert.equal(isNativeEditAction('unknown'), false);

  const editCalls: string[] = [];
  const template = buildMacApplicationMenuTemplate({
    appName: '左人剪刀',
    includeDevTools: false,
    onEditAction: (action) => editCalls.push(action),
  });
  assert.equal(template.length, 5);
  const appMenu = template[0]!;
  const fileMenu = template[1]!;
  const editMenu = template[2]!;
  const viewMenu = template[3]!;
  const windowMenu = template[4]!;

  const appSub = Array.isArray(appMenu.submenu) ? appMenu.submenu : [];
  assert.ok(appSub.some((item) => item.role === 'quit'));
  assert.ok(appSub.some((item) => item.role === 'hide'));

  const fileSub = Array.isArray(fileMenu.submenu) ? fileMenu.submenu : [];
  assert.ok(fileSub.some((item) => item.role === 'close'));

  const editSub = Array.isArray(editMenu.submenu) ? editMenu.submenu : [];
  assert.equal(editSub.length, NATIVE_EDIT_ACTIONS.length);
  for (const item of editSub) {
    assert.equal(item.role, undefined, 'macOS Edit menu must omit Cocoa roles so renderer receives Cmd+Z/C/V/X/A');
    assert.equal(item.accelerator, undefined, 'macOS Edit menu must omit accelerators');
  }
  editSub.forEach((item) => item.click?.(undefined as never, undefined, undefined as never));
  assert.deepEqual(editCalls, [...NATIVE_EDIT_ACTIONS]);

  const viewSub = Array.isArray(viewMenu.submenu) ? viewMenu.submenu : [];
  for (const forbidden of ['reload', 'forceReload', 'zoomIn', 'zoomOut', 'resetZoom', 'toggleDevTools']) {
    assert.ok(!viewSub.some((item) => item.role === forbidden), `View menu must not define ${forbidden} in packaged mode`);
  }
  const devTemplate = buildMacApplicationMenuTemplate({
    appName: '左人剪刀',
    includeDevTools: true,
    onEditAction: () => undefined,
  });
  const devViewSub = Array.isArray(devTemplate[3]!.submenu) ? devTemplate[3]!.submenu : [];
  assert.ok(devViewSub.some((item) => item.role === 'toggleDevTools'));

  const winSub = Array.isArray(windowMenu.submenu) ? windowMenu.submenu : [];
  assert.ok(!winSub.some((item) => item.role === 'minimize'), 'Window menu must omit minimize role so Cmd+M reaches marker shortcut');
  assert.ok(!winSub.some((item) => item.accelerator), 'Window menu must not bind Cmd+M');

  let setAppMenuCount = 0;
  let copiedCount = 0;
  assert.equal(
    installDesktopApplicationMenu({
      platform: 'win32',
      menuApi: {
        buildFromTemplate: () => ({}) as Electron.Menu,
        setApplicationMenu: () => { setAppMenuCount += 1; },
      },
    }),
    false,
  );
  assert.equal(setAppMenuCount, 0);

  let builtTemplate: Array<Electron.MenuItemConstructorOptions | Electron.MenuItem> = [];
  assert.equal(
    installDesktopApplicationMenu({
      platform: 'darwin',
      isPackaged: true,
      menuApi: {
        buildFromTemplate: (t) => {
          builtTemplate = t;
          return {} as Electron.Menu;
        },
        setApplicationMenu: () => { setAppMenuCount += 1; },
      },
      getFocusedWindow: () => ({
        webContents: {
          undo: () => undefined,
          redo: () => undefined,
          cut: () => undefined,
          copy: () => { copiedCount += 1; },
          paste: () => undefined,
          selectAll: () => undefined,
        },
      }),
    }),
    true,
  );
  assert.equal(setAppMenuCount, 1);
  const copyItem = (builtTemplate[2]!.submenu as Electron.MenuItemConstructorOptions[]).find((i) => i.label === '复制');
  copyItem?.click?.(undefined as never, undefined, undefined as never);
  assert.equal(copiedCount, 1);
}

console.log('desktop window-frame verification passed');
