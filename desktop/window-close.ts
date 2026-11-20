import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';
import { getKey, setKeys } from '../server/keystore.ts';
import { DESKTOP_CLOSE_BEHAVIOR_KEY } from '../shared/desktop-close-behavior.ts';
import { focusExistingWindow } from './single-instance.ts';

export function installMainWindowCloseBehavior(win: BrowserWindow, iconPath: string): void {
  let tray: Tray | undefined;
  let pending = false;
  let quitting = false;
  let companions: BrowserWindow[] = [];

  const markQuitting = () => { quitting = true; };
  app.on('before-quit', markQuitting);
  win.webContents.on('will-prevent-unload', () => { quitting = false; });
  win.on('show', () => {
    for (const companion of companions) {
      if (!companion.isDestroyed()) companion.showInactive();
    }
    companions = [];
  });
  win.once('closed', () => {
    app.off('before-quit', markQuitting);
    tray?.destroy();
  });

  function hideToTray(): void {
    if (!tray) {
      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error('Missing tray icon');
      const nextTray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 16 }) : icon);
      try {
        const restore = () => focusExistingWindow(win);
        nextTray.setToolTip('左人剪刀');
        nextTray.setContextMenu(Menu.buildFromTemplate([
          { label: '打开左人剪刀', click: restore },
          { label: '彻底关闭', click: () => app.quit() },
        ]));
        nextTray.on('click', restore);
        tray = nextTray;
      } catch (error) {
        nextTray.destroy();
        throw error;
      }
    }
    companions = BrowserWindow.getAllWindows().filter((other) => other !== win && other.isVisible());
    for (const companion of companions) companion.hide();
    win.hide();
  }

  async function closeOrHide(): Promise<void> {
    const saved = getKey(DESKTOP_CLOSE_BEHAVIOR_KEY);
    let choice = saved === 'quit' || saved === 'background' ? saved : null;
    let remember = false;
    if (!choice) {
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        title: '关闭左人剪刀',
        message: '关闭窗口后，左人剪刀要继续运行吗？',
        detail: '隐藏后，可以从系统托盘重新打开窗口。',
        buttons: ['彻底关闭', '隐藏后台', '取消'],
        defaultId: 1,
        cancelId: 2,
        checkboxLabel: '下次不再提醒',
      });
      choice = result.response === 0 ? 'quit' : result.response === 1 ? 'background' : null;
      remember = result.checkboxChecked;
    }
    if (!choice || quitting || win.isDestroyed()) return;
    if (choice === 'background') hideToTray();
    if (remember) {
      await setKeys({ [DESKTOP_CLOSE_BEHAVIOR_KEY]: choice }).catch((error: unknown) => {
        console.warn('[desktop] could not remember close behavior:', error);
      });
    }
    if (choice === 'quit' && !quitting && !win.isDestroyed()) app.quit();
  }

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    void closeOrHide().catch((error: unknown) => {
      console.warn('[desktop] close behavior failed:', error);
      if (!quitting && !win.isDestroyed()) dialog.showErrorBox('左人剪刀', '无法完成关闭操作，请重试。');
    }).finally(() => { pending = false; });
  });
}
