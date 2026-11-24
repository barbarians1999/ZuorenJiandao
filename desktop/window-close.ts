import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { getKey, setKeys } from '../server/keystore.ts';
import {
  DESKTOP_CLOSE_BEHAVIOR_KEY,
  DESKTOP_CLOSE_CONFIRM_CHANNELS,
} from '../shared/desktop-close-behavior.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { focusExistingWindow } from './single-instance.ts';
import { createMainWindowCloseController } from './window-close-controller.ts';

export function installMainWindowCloseBehavior(
  win: BrowserWindow,
  iconPath: string,
  trustedOrigin: string,
): void {
  let tray: Tray | undefined;
  let companions: BrowserWindow[] = [];

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

  const controller = createMainWindowCloseController({
    getSavedBehavior: () => getKey(DESKTOP_CLOSE_BEHAVIOR_KEY),
    saveBehavior: async (choice) => {
      await setKeys({ [DESKTOP_CLOSE_BEHAVIOR_KEY]: choice });
    },
    hideToTray,
    quitApp: () => app.quit(),
    isWindowDestroyed: () => win.isDestroyed(),
    isWindowMinimized: () => win.isMinimized(),
    restoreWindow: () => win.restore(),
    showWindow: () => win.show(),
    focusWindow: () => win.focus(),
    isRendererCrashed: () => win.webContents.isCrashed(),
    sendPrompt: (request) => win.webContents.send(DESKTOP_CLOSE_CONFIRM_CHANNELS.prompt, request),
    showNativeDialog: async () => {
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
      return {
        choice: result.response === 0 ? 'quit' : result.response === 1 ? 'background' : null,
        remember: result.checkboxChecked,
      };
    },
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  });

  const assertCloseSender = (event: Electron.IpcMainInvokeEvent): void => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (event.sender !== win.webContents) {
      throw new Error('unexpected window close IPC sender');
    }
  };

  ipcMain.removeHandler(DESKTOP_CLOSE_CONFIRM_CHANNELS.ready);
  ipcMain.removeHandler(DESKTOP_CLOSE_CONFIRM_CHANNELS.respond);
  ipcMain.handle(DESKTOP_CLOSE_CONFIRM_CHANNELS.ready, (event, ready: unknown) => {
    assertCloseSender(event);
    controller.setRendererPromptReady(ready === true);
  });
  ipcMain.handle(DESKTOP_CLOSE_CONFIRM_CHANNELS.respond, (event, value: unknown) => {
    assertCloseSender(event);
    controller.handlePromptResponse(value);
  });

  const handleDidStartNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) controller.setRendererPromptReady(false);
  };
  const handleRenderProcessGone = () => controller.setRendererPromptReady(false);
  const handleBeforeQuit = () => controller.markQuitting();
  const handleWillPreventUnload = () => controller.resetQuitting();
  const handleShow = () => {
    for (const companion of companions) {
      if (!companion.isDestroyed()) companion.showInactive();
    }
    companions = [];
  };

  app.on('before-quit', handleBeforeQuit);
  win.webContents.on('did-start-navigation', handleDidStartNavigation);
  win.webContents.on('render-process-gone', handleRenderProcessGone);
  win.webContents.on('will-prevent-unload', handleWillPreventUnload);
  win.on('show', handleShow);
  win.on('close', controller.handleWindowClose);
  win.once('closed', () => {
    app.off('before-quit', handleBeforeQuit);
    ipcMain.removeHandler(DESKTOP_CLOSE_CONFIRM_CHANNELS.ready);
    ipcMain.removeHandler(DESKTOP_CLOSE_CONFIRM_CHANNELS.respond);
    controller.dispose();
    tray?.destroy();
  });
}
