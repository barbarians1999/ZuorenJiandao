import { useState } from 'react';
import type { MultiWindowConflictInfo } from '../agent/external-bridge-registration';
import { useT } from '../i18n/locale';
import { theme } from '../theme';

function holderLabel(kind: MultiWindowConflictInfo['holderClientKind'], t: (k: string) => string): string {
  if (kind === 'desktop') return t('桌面客户端');
  if (kind === 'browser') return t('浏览器');
  return t('另一');
}

export function MultiWindowConflictBanner({
  conflict,
  onTakeover,
  onHome,
}: {
  conflict: MultiWindowConflictInfo | null;
  onTakeover: () => void;
  onHome: () => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);

  if (!conflict) return null;
  const holder = holderLabel(conflict.holderClientKind, t);
  const takenOver = conflict.code === 'OWNERSHIP_TAKEN_OVER';
  const headline = takenOver
    ? t('编辑控制权已被{holder}窗口接管', { holder })
    : t('该工程已在{holder}窗口打开', { holder });
  const detail = takenOver
    ? t('为防止两个窗口同时写入造成工程损坏或编辑中断，当前窗口已暂停自动保存并切换为只读保护模式。')
    : t('同一工程同时仅保留一个主控编辑窗口；当前窗口已自动切换为只读保护模式，不会覆盖另一窗口的改动。');

  if (dismissed) {
    return (
      <div
        role="status"
        data-multi-window-conflict="readonly-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '7px 14px',
          background: 'color-mix(in srgb, var(--cc-gold) 14%, var(--cc-panel-alt))',
          border: `1px solid color-mix(in srgb, var(--cc-gold) 38%, ${theme.border})`,
          color: theme.text,
          borderRadius: 12,
          fontSize: 12.5,
          marginTop: 6,
          flexShrink: 0,
        }}
      >
        <span>⚠ {t('只读保护模式')}：{headline}</span>
        <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            className="cc-insp-btn primary"
            onClick={() => { setDismissed(false); onTakeover(); }}
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            {t('在此窗口接管编辑')}
          </button>
          <button
            type="button"
            className="cc-insp-btn"
            onClick={onHome}
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            {t('返回工程列表')}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-multi-window-conflict="modal"
      className="cc-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(var(--cc-shadow-rgb), 0.68)',
        backdropFilter: 'blur(4px)',
        padding: 16,
      }}
    >
      <div
        className="cc-modal"
        style={{
          width: 'min(480px, 100%)',
          background: theme.panel,
          border: `1px solid ${theme.borderLight}`,
          borderRadius: 16,
          padding: '22px 24px',
          display: 'grid',
          gap: 12,
          boxShadow: '0 24px 64px rgba(var(--cc-shadow-rgb), 0.55)',
        }}
      >
        <strong style={{ fontSize: 15, color: 'var(--cc-text-strong)' }}>⚠ {headline}</strong>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: theme.textDim }}>
          {detail}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <button
            type="button"
            className="cc-insp-btn"
            onClick={onHome}
            style={{ padding: '7px 14px', fontSize: 12.5 }}
          >
            {t('返回工程列表')}
          </button>
          <button
            type="button"
            className="cc-insp-btn"
            onClick={() => setDismissed(true)}
            style={{ padding: '7px 14px', fontSize: 12.5 }}
          >
            {t('继续只读查看')}
          </button>
          <button
            type="button"
            className="cc-insp-btn primary"
            onClick={onTakeover}
            style={{ padding: '7px 16px', fontSize: 12.5 }}
          >
            {t('在此窗口接管编辑')}
          </button>
        </div>
      </div>
    </div>
  );
}
