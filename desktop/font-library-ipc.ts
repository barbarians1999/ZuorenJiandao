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
  handle(DESKTOP_FONT_CHANNELS.listImported, () => library.listImportedFonts());
  const pickFontPaths = async (sender: Electron.WebContents) => {
    const parent = BrowserWindow.fromWebContents(sender);
    const options = { title: '导入本地字体', properties: ['openFile' as const, 'multiSelections' as const], filters: [
      { name: '字体文件（TTF / OTF / TTC）', extensions: ['ttf', 'otf', 'ttc'] },
    ] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths;
  };
  handle(DESKTOP_FONT_CHANNELS.choose, async (event) => {
    const paths = await pickFontPaths(event.sender);
    if (!paths) return null;
    const faces = [];
    for (const filePath of paths) {
      faces.push(...await library.inspect(filePath, 'imported'));
    }
    return faces;
  });
  handle(DESKTOP_FONT_CHANNELS.importFiles, async (event) => {
    const paths = await pickFontPaths(event.sender);
    return paths ? library.importFontFiles(paths) : null;
  });
  handle(DESKTOP_FONT_CHANNELS.preview, (_event, faceId: unknown) => library.previewFont(faceId));
  handle(DESKTOP_FONT_CHANNELS.materialize, (_event, faceId: unknown) => library.materializeFont(faceId));
}
