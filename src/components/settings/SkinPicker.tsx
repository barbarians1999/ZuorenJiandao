// Theme switcher: Night/Day mode segmented switch + 4 design-language families
// Preview + name + tagline + check mark. Takes effect immediately via applySkin (<html data-cc-skin>),
// persisted in localStorage; shared between Dashboard and Editor TopBar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import {
  SKIN_FAMILIES,
  type SkinFamilyId,
  type SkinMode,
  applySkin,
  findSkinByFamilyAndMode,
  getSkin,
  getSkinDef,
} from '../../skins';
import { Icon } from '../icons';

export function SkinPicker() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [currentId, setCurrentId] = useState(getSkin);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 52, right: 16 });

  const updatePos = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 300)),
      right: Math.max(8, Math.min(window.innerWidth - 280, window.innerWidth - rect.right)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setCurrentId(getSkin());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-cc-skin', 'data-cc-skin-family'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const activeDef = getSkinDef(currentId);

  const pickFamily = (family: SkinFamilyId): void => {
    const next = findSkinByFamilyAndMode(family, activeDef.mode);
    applySkin(next.id);
    setCurrentId(next.id);
  };

  const pickMode = (mode: SkinMode): void => {
    const next = findSkinByFamilyAndMode(activeDef.family, mode);
    applySkin(next.id);
    setCurrentId(next.id);
  };

  const overlay = open ? (
    <>
      <div className="cc-skin-picker-backdrop" onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 2100 }} />
      <div
        role="menu"
        aria-label={t('主题')}
        className="cc-skin-picker-popover"
        style={{ ...pop, position: 'fixed', top: pos.top, right: pos.right, zIndex: 2101 }}
      >
        <div style={headRow}>
          <span style={headLabel}>{t('界面主题')}</span>
          <div role="group" aria-label={t('日间或夜间模式')} className="cc-skin-picker-mode-group" style={modeGroup}>
            <button
              type="button"
              aria-pressed={activeDef.mode === 'dark'}
              onClick={() => pickMode('dark')}
              className={`cc-skin-picker-mode-btn${activeDef.mode === 'dark' ? ' is-active' : ''}`}
              style={modeBtn(activeDef.mode === 'dark')}
            >
              <Icon name="moon" size={12} />
              <span>{t('夜间')}</span>
            </button>
            <button
              type="button"
              aria-pressed={activeDef.mode === 'light'}
              onClick={() => pickMode('light')}
              className={`cc-skin-picker-mode-btn${activeDef.mode === 'light' ? ' is-active' : ''}`}
              style={modeBtn(activeDef.mode === 'light')}
            >
              <Icon name="sun" size={12} />
              <span>{t('日间')}</span>
            </button>
          </div>
        </div>

        {SKIN_FAMILIES.map((family) => {
          const target = findSkinByFamilyAndMode(family.id, activeDef.mode);
          const active = activeDef.family === family.id;
          return (
            <button
              key={family.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => pickFamily(family.id)}
              className={`cc-skin-picker-option${active ? ' is-active' : ''}`}
              style={{
                ...row,
                background: active ? theme.panel : 'none',
                boxShadow: active ? `inset 0 0 0 1px ${theme.accent}` : undefined,
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.panel; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}
            >
              <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
                <span className="cc-skin-picker-dot" style={dot(target.tokens.bg)} />
                <span className="cc-skin-picker-dot" style={dot(target.tokens.panelAlt)} />
                <span className="cc-skin-picker-dot" style={dot(target.tokens.accent)} />
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontWeight: active ? 650 : 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(family.nameZh)}
                </span>
                <span style={{ fontSize: 11, color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(family.taglineZh)}
                </span>
              </span>
              {active && (
                <span style={{ color: theme.accent, display: 'inline-flex', flexShrink: 0 }}>
                  <Icon name="check" size={13} strokeWidth={2.4} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  ) : null;

  return (
    <div data-cc-titlebar-control="true" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        data-tip={t('主题')}
        aria-label={t('主题')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cc-topbar-icon-button cc-skin-picker-trigger cc-tip cc-tip-r"
        onClick={() => setOpen((o) => !o)}
        style={{
          ...trigger,
          color: open ? theme.text : theme.textDim,
          background: open ? theme.panelAlt : 'none',
        }}
      >
        <Icon name="brush" size={19} />
      </button>
      {overlay && (typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay)}
    </div>
  );
}

const trigger: React.CSSProperties = {
  width: 36, height: 36,
  border: 'none', cursor: 'pointer', padding: 6, borderRadius: 999, display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', background: 'none',
};

const pop: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 121, minWidth: 268,
  background: theme.panelAlt, border: `1px solid ${themeAlpha.ink(0.10)}`, borderRadius: 14,
  boxShadow: `0 14px 36px ${themeAlpha.shadow(0.45)}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 3,
};

const headRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 6px 6px',
};

const headLabel: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 650, color: theme.textDim, letterSpacing: 0.2,
};

const modeGroup: React.CSSProperties = {
  display: 'inline-flex', padding: 2, borderRadius: 999,
  background: theme.inset, border: `1px solid ${themeAlpha.ink(0.08)}`, gap: 2,
};

function modeBtn(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px',
    border: 'none', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 11.5,
    fontWeight: active ? 650 : 500,
    background: active ? theme.panel : 'transparent',
    color: active ? theme.accent : theme.textMuted,
    boxShadow: active ? `inset 0 0 0 1px ${theme.accent}` : 'none',
  };
}

const row: React.CSSProperties = {
  font: 'inherit', fontSize: 13.5, lineHeight: 1.35, minHeight: 44, display: 'flex', alignItems: 'center', gap: 10,
  width: '100%', padding: '7px 10px', border: 'none', borderRadius: 10, cursor: 'pointer', color: theme.text,
};

function dot(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: color, border: `0.5px solid ${themeAlpha.ink(0.45)}` };
}
