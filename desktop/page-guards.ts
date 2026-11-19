import { shell, type BrowserWindow } from 'electron';
import { resolveDesktopPageUrlDecision } from './page-origin.ts';
import type { DesktopPageUrlDecision, DesktopPageUrlSurface } from './page-origin.ts';

function handOffExternalUrl(decision: DesktopPageUrlDecision): void {
  if (decision.action !== 'open-external') return;
  void shell.openExternal(decision.url).catch((error: unknown) => {
    console.error('[desktop] failed to open external URL:', error);
  });
}

/** Keep both editor and transcript windows inside their trusted app origin. */
export function installDesktopPageGuards(win: BrowserWindow, trustedOrigin: string): void {
  const guardNavigation = (surface: Extract<DesktopPageUrlSurface, 'navigation' | 'redirect'>) => (
    event: { preventDefault(): void },
    requestedUrl: string,
  ): void => {
    const decision = resolveDesktopPageUrlDecision(requestedUrl, trustedOrigin, surface);
    if (decision.action === 'allow') return;
    event.preventDefault();
    handOffExternalUrl(decision);
  };

  win.webContents.on('will-navigate', guardNavigation('navigation'));
  win.webContents.on('will-redirect', guardNavigation('redirect'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = resolveDesktopPageUrlDecision(url, trustedOrigin, 'popup');
    handOffExternalUrl(decision);
    return { action: 'deny' };
  });
}
