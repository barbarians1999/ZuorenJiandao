import { useT } from '../i18n/locale';
import { useEffect } from 'react';
import { getSkin, SKINS } from '../skins';

interface WindowControlsOverlayLike {
  visible?: boolean;
  getTitlebarAreaRect?: () => DOMRect;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

const WIN32_CAPTION_CLUSTER_BASE_PX = 160;
const WIN32_CAPTION_MIN_SAFE_RIGHT_PX = 168;

/** Convert physical Windows caption-cluster width into CSS pixels at any shrink/user zoom. */
export function resolveWindowsTitlebarSafeRightPx({
  outerWidth,
  innerWidth,
  overlayRightInsetCss = 0,
}: {
  outerWidth: number;
  innerWidth: number;
  overlayRightInsetCss?: number;
}): number {
  const ratio = outerWidth > 0 && innerWidth > 0 ? Math.min(1, outerWidth / innerWidth) : 1;
  const effectiveZoom = Math.max(0.5, ratio);
  const zoomFloor = Math.ceil(WIN32_CAPTION_CLUSTER_BASE_PX / effectiveZoom);
  const wcoFloor = overlayRightInsetCss > 0 && Number.isFinite(overlayRightInsetCss)
    ? Math.ceil(overlayRightInsetCss) + 18
    : 0;
  return Math.max(WIN32_CAPTION_MIN_SAFE_RIGHT_PX, zoomFloor, wcoFloor);
}

type DesktopWindowAction = 'close' | 'minimize' | 'toggle-maximize';

interface DesktopWindowControlButtonsProps {
  translate: (text: string) => string;
  onAction: (action: DesktopWindowAction) => void;
}

export function DesktopWindowControlButtons({
  translate,
  onAction,
}: DesktopWindowControlButtonsProps) {
  return (
    <div className="cc-window-controls" aria-label={translate('窗口控制')}>
      <button
        type="button"
        className="cc-window-control cc-window-control--close cc-tip"
        aria-label={translate('关闭窗口')}
        data-tip={translate('关闭窗口')}
        onClick={() => onAction('close')}
      >
        <span className="cc-window-control-glyph" aria-hidden="true">×</span>
      </button>
      <button
        type="button"
        className="cc-window-control cc-window-control--minimize cc-tip"
        aria-label={translate('最小化窗口')}
        data-tip={translate('最小化窗口')}
        onClick={() => onAction('minimize')}
      >
        <span className="cc-window-control-glyph" aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="cc-window-control cc-window-control--maximize cc-tip"
        aria-label={translate('缩放窗口')}
        data-tip={translate('缩放窗口')}
        onClick={() => onAction('toggle-maximize')}
      >
        <span className="cc-window-control-glyph" aria-hidden="true">+</span>
      </button>
    </div>
  );
}

export function DesktopWindowControls() {
  const t = useT();
  const desktop = window.openChatCutDesktop;
  useEffect(() => {
    if (desktop?.platform !== 'win32' || !desktop.setTitlebarAppearance) return;
    const header = document.querySelector<HTMLElement>('.cc-window-titlebar');
    if (!header) return;
    const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay;
    let rafId = 0;
    const sync = () => {
      const { tokens } = SKINS.find((skin) => skin.id === getSkin()) ?? SKINS[0]!;
      const inEditor = Boolean(header.closest('.cc-editor-shell'));
      const overlayRect = wco?.visible ? wco.getTitlebarAreaRect?.() : undefined;
      const clientWidth = document.documentElement.clientWidth || window.innerWidth;
      const overlayRightInsetCss = overlayRect && overlayRect.width > 0 && clientWidth > 0
        ? Math.max(0, clientWidth - overlayRect.right)
        : 0;
      const safeRight = resolveWindowsTitlebarSafeRightPx({
        outerWidth: window.outerWidth,
        innerWidth: window.innerWidth,
        overlayRightInsetCss,
      });
      document.documentElement.style.setProperty('--cc-win-titlebar-safe-right', `${safeRight}px`);
      const headerHeight = Math.max(32, Math.floor(header.getBoundingClientRect().height || header.offsetHeight));
      void desktop.setTitlebarAppearance!({
        color: inEditor ? tokens.bg : tokens.panel,
        symbolColor: tokens.text,
        height: headerHeight,
      })
        .catch((error: unknown) => console.warn('Titlebar appearance sync failed', error));
    };
    const scheduleSync = () => {
      sync();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(sync);
    };
    const themeObserver = new MutationObserver(scheduleSync);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cc-skin'] });
    const sizeObserver = new ResizeObserver(scheduleSync);
    sizeObserver.observe(header);
    window.addEventListener('resize', scheduleSync);
    wco?.addEventListener?.('geometrychange', scheduleSync);
    const unsubscribe = desktop.subscribeUiScale?.(scheduleSync);
    scheduleSync();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      sizeObserver.disconnect();
      window.removeEventListener('resize', scheduleSync);
      wco?.removeEventListener?.('geometrychange', scheduleSync);
      unsubscribe?.();
    };
  }, [desktop]);
  if (desktop?.platform !== 'darwin') return null;

  return (
    <DesktopWindowControlButtons
      translate={t}
      onAction={(action) => { void desktop.windowAction(action); }}
    />
  );
}
