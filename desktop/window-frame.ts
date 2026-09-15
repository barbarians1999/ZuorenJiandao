import type { BrowserWindowConstructorOptions } from 'electron';

type DesktopWindowFrameOptions = Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'autoHideMenuBar'>;

interface DesktopWindowFrameHost {
  setWindowButtonVisibility(visible: boolean): void;
  setMenu(menu: null): void;
}

export function desktopWindowFrameOptions(
  platform: NodeJS.Platform = process.platform,
): DesktopWindowFrameOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161a', symbolColor: '#e6e6e8', height: 36 }, autoHideMenuBar: true };
  return {};
}

export function applyDesktopWindowFrame(
  win: DesktopWindowFrameHost,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') win.setWindowButtonVisibility(false);
  if (platform === 'win32') win.setMenu(null);
}
