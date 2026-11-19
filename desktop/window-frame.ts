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
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#fffdf8', symbolColor: '#28241d', height: 52 }, autoHideMenuBar: true };
  return {};
}

/** Accept only concrete theme colors and bounded CSS height, not arbitrary window options. */
export function resolveTitlebarAppearance(value: unknown, zoom: number) {
  if (!value || typeof value !== 'object') return null;
  const { color, symbolColor, height } = value as Record<string, unknown>;
  const hex = /^#[0-9a-f]{6}$/i;
  if (typeof color !== 'string' || !hex.test(color) || typeof symbolColor !== 'string' || !hex.test(symbolColor)
    || typeof height !== 'number' || !Number.isFinite(height) || height < 32 || height > 80
    || !Number.isFinite(zoom) || zoom <= 0) return null;
  return { color, symbolColor, height: Math.min(160, Math.max(32, Math.round(height * zoom))) };
}

export function applyDesktopWindowFrame(
  win: DesktopWindowFrameHost,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') win.setWindowButtonVisibility(false);
  if (platform === 'win32') win.setMenu(null);
}
