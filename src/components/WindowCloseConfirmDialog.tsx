import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DesktopClosePromptAction } from '../../shared/desktop-close-behavior';
import { useT } from '../i18n/locale';
import { theme, themeAlpha } from '../theme';
import { BrandMark, Icon } from './icons';

export interface WindowCloseConfirmModalProps {
  open: boolean;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  onAction: (action: DesktopClosePromptAction) => void;
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 3000,
  display: 'grid',
  placeItems: 'center',
  padding: 16,
  background: themeAlpha.shadow(0.6),
  backdropFilter: 'blur(4px)',
  fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
};

const cardStyle: CSSProperties = {
  width: 'min(420px, calc(100vw - 32px))',
  borderRadius: 18,
  background: theme.panel,
  color: theme.text,
  border: `1px solid ${theme.border}`,
  boxShadow: `0 24px 64px ${themeAlpha.shadow(0.65)}`,
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '14px 18px',
  borderBottom: `1px solid ${theme.border}`,
};

const closeBtnStyle: CSSProperties = {
  marginLeft: 'auto',
  width: 30,
  height: 30,
  padding: 0,
  border: 'none',
  borderRadius: 999,
  background: theme.panelAlt,
  color: theme.textDim,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
};

const bodyStyle: CSSProperties = {
  padding: '18px 20px 16px',
};

const titleStyle: CSSProperties = {
  margin: '0 0 6px',
  fontSize: 15.5,
  fontWeight: 650,
  color: theme.textStrong,
  lineHeight: 1.4,
};

const detailStyle: CSSProperties = {
  margin: '0 0 16px',
  fontSize: 13,
  color: theme.textDim,
  lineHeight: 1.55,
};

const checkboxLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: theme.textDim,
  cursor: 'pointer',
  userSelect: 'none',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 20px',
  borderTop: `1px solid ${theme.border}`,
  background: theme.panel,
};

const ghostBtnStyle: CSSProperties = {
  padding: '8px 15px',
  borderRadius: 999,
  border: '1px solid transparent',
  background: 'transparent',
  color: theme.textDim,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 550,
  cursor: 'pointer',
};

const dangerBtnStyle: CSSProperties = {
  padding: '8px 16px',
  borderRadius: 999,
  border: '1px solid transparent',
  background: theme.panelAlt,
  color: theme.danger,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const primaryBtnStyle: CSSProperties = {
  padding: '8px 18px',
  borderRadius: 999,
  border: '1px solid transparent',
  background: theme.accent,
  color: theme.onAccent,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 650,
  cursor: 'pointer',
};

export function WindowCloseConfirmModal({
  open,
  remember,
  onRememberChange,
  onAction,
}: WindowCloseConfirmModalProps) {
  const t = useT();
  if (!open) return null;
  return (
    <div role="presentation" onMouseDown={() => onAction('cancel')} style={backdropStyle}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-close-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={cardStyle}
      >
        <header style={headerStyle}>
          <span aria-hidden="true" style={{ display: 'inline-flex' }}><BrandMark size={18} /></span>
          <b style={{ fontSize: 14, color: theme.textStrong }}>{t('关闭左人剪刀')}</b>
          <button
            type="button"
            aria-label={t('取消')}
            onClick={() => onAction('cancel')}
            style={closeBtnStyle}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        <div style={bodyStyle}>
          <h2 id="cc-close-dialog-title" style={titleStyle}>
            {t('关闭窗口后，左人剪刀要继续运行吗？')}
          </h2>
          <p style={detailStyle}>
            {t('隐藏后，可以从系统托盘重新打开窗口。')}
          </p>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => onRememberChange(event.target.checked)}
              style={{ accentColor: theme.accent, width: 15, height: 15, cursor: 'pointer' }}
            />
            <span>{t('下次不再提醒')}</span>
          </label>
        </div>
        <footer style={footerStyle}>
          <button type="button" onClick={() => onAction('cancel')} style={ghostBtnStyle}>
            {t('取消')}
          </button>
          <button type="button" onClick={() => onAction('quit')} style={dangerBtnStyle}>
            {t('彻底关闭')}
          </button>
          <button type="button" autoFocus onClick={() => onAction('background')} style={primaryBtnStyle}>
            {t('隐藏后台')}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function WindowCloseConfirmDialog() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    const desktop = typeof window !== 'undefined' ? window.openChatCutDesktop : undefined;
    if (!desktop?.subscribeClosePrompt) return;
    const unsubscribe = desktop.subscribeClosePrompt((request) => {
      submittingRef.current = false;
      setRemember(false);
      setRequestId(request.requestId);
    });
    void desktop.setClosePromptReady?.(true).catch(() => undefined);
    return () => {
      unsubscribe();
      void desktop.setClosePromptReady?.(false).catch(() => undefined);
    };
  }, []);

  const respond = (action: DesktopClosePromptAction) => {
    if (!requestId || submittingRef.current) return;
    submittingRef.current = true;
    const activeId = requestId;
    const shouldRemember = action === 'cancel' ? false : remember;
    setRequestId(null);
    setRemember(false);
    void window.openChatCutDesktop?.respondClosePrompt?.({
      requestId: activeId,
      action,
      remember: shouldRemember,
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (!requestId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      respond('cancel');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  return (
    <WindowCloseConfirmModal
      open={requestId !== null}
      remember={remember}
      onRememberChange={setRemember}
      onAction={respond}
    />
  );
}
