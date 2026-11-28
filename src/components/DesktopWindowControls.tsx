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
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onAction('close')}
      >
        <span className="cc-window-control-glyph" aria-hidden="true">×</span>
      </button>
      <button
        type="button"
        className="cc-window-control cc-window-control--minimize cc-tip"
        aria-label={translate('最小化窗口')}
        data-tip={translate('最小化窗口')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onAction('minimize')}
      >
        <span className="cc-window-control-glyph" aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="cc-window-control cc-window-control--maximize cc-tip"
        aria-label={translate('缩放窗口')}
        data-tip={translate('缩放窗口')}
        onMouseDown={(event) => event.preventDefault()}
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
    let lastSafeRight = -1;
    let lastColor = '';
    let lastSymbolColor = '';
    let lastHeight = -1;
    const sync = () => {
      const { tokens } = SKINS.find((skin) => skin.id === getSkin()) ?? SKINS[0]!;
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
      const rawHeight = header.getBoundingClientRect().height || header.offsetHeight;
      const borderBottom = parseFloat(window.getComputedStyle(header).borderBottomWidth || '0') || 0;
      const headerHeight = Math.max(32, Math.floor(rawHeight - Math.ceil(borderBottom) - 1));
      if (safeRight !== lastSafeRight) {
        lastSafeRight = safeRight;
        document.documentElement.style.setProperty('--cc-win-titlebar-safe-right', `${safeRight}px`);
      }
      const color = tokens.panel;
      const symbolColor = tokens.textMuted;
      if (color !== lastColor || symbolColor !== lastSymbolColor || headerHeight !== lastHeight) {
        lastColor = color;
        lastSymbolColor = symbolColor;
        lastHeight = headerHeight;
        void desktop.setTitlebarAppearance!({
          color,
          symbolColor,
          height: headerHeight,
        })
          .catch((error: unknown) => console.warn('Titlebar appearance sync failed', error));
      }
    };
    const scheduleSync = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        sync();
      });
    };
    const themeObserver = new MutationObserver(scheduleSync);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cc-skin', 'data-cc-skin-family', 'data-cc-skin-mode'] });
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
