import { BrowserWindow, dialog, ipcMain } from 'electron';
import { DESKTOP_FONT_CHANNELS } from '../shared/desktop-fonts.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { createDesktopFontLibrary } from './font-library.ts';

export function installDesktopFontsIpc(trustedOrigin: string): void {
  const library = createDesktopFontLibrary();
  type Handler = Parameters<typeof ipcMain.handle>[1];
  const handle = (channel: string, callback: Handler) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    return callback(event, ...args);
  });
  handle(DESKTOP_FONT_CHANNELS.list, (_event, refresh: unknown) => {
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('invalid font refresh request');
    return library.listSystemFonts(refresh === true);
  });
  handle(DESKTOP_FONT_CHANNELS.choose, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = { title: '导入本地字体', properties: ['openFile' as const], filters: [
      { name: '字体文件（TTF / OTF / TTC）', extensions: ['ttf', 'otf', 'ttc'] },
    ] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled || !picked.filePaths[0] ? null : library.inspect(picked.filePaths[0], 'imported');
  });
  handle(DESKTOP_FONT_CHANNELS.preview, (_event, faceId: unknown) => library.previewFont(faceId));
  handle(DESKTOP_FONT_CHANNELS.materialize, (_event, faceId: unknown) => library.materializeFont(faceId));
}
