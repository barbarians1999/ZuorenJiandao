// Skin selector: brush button + drop-down card, row = three-color point (bottom/panel/accent)
// Preview + name + check mark. The switch takes effect immediately (applySkin changes to <html data-cc-skin>),
// localStorage is persistent; TopBar is shared with Dashboard header.
import { useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { SKINS, applySkin, getSkin } from '../../skins';
import { Icon } from '../icons';

export function SkinPicker() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(getSkin);
  const pick = (id: string): void => { applySkin(id); setCurrent(id); };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" data-tip={t('皮肤')} aria-label={t('皮肤')}
        aria-haspopup="menu" aria-expanded={open} className="cc-topbar-icon-button cc-skin-picker-trigger cc-tip cc-tip-r" onClick={() => setOpen((o) => !o)}
        style={{ ...trigger, color: open ? theme.text : theme.textDim, background: open ? theme.panelAlt : 'none' }}>
        <Icon name="brush" size={19} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 120 }} />
          <div role="menu" aria-label={t('皮肤')} style={pop}>
            <div style={head}>{t('皮肤')}</div>
            {SKINS.map((s) => {
              const active = current === s.id;
              return (
                <button key={s.id} type="button" role="menuitemradio" aria-checked={active} onClick={() => pick(s.id)}
                  className={`cc-skin-picker-option${active ? ' is-active' : ''}`}
                  style={{ ...row, background: active ? theme.panel : 'none', boxShadow: active ? `inset 0 0 0 1px ${theme.accent}` : undefined }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.panel; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}>
                  <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
                    <span style={dot(s.tokens.bg)} />
                    <span style={dot(s.tokens.panelAlt)} />
                    <span style={dot(s.tokens.accent)} />
                  </span>
                  <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(s.nameZh)}</span>
                  {active && <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="check" size={12} strokeWidth={2.4} /></span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const trigger: React.CSSProperties = {
  width: 36, height: 36,
  border: 'none', cursor: 'pointer', padding: 6, borderRadius: 999, display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', background: 'none',
};
const pop: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 121, minWidth: 204,
  background: theme.panelAlt, border: `1px solid ${themeAlpha.ink(0.08)}`, borderRadius: 14,
  boxShadow: `0 14px 36px ${themeAlpha.shadow(0.5)}`, padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
};
const head: React.CSSProperties = { fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: theme.textDim, padding: '6px 10px', letterSpacing: 0.2 };
const row: React.CSSProperties = {
  font: 'inherit', fontSize: 14, lineHeight: 1.4, minHeight: 38, display: 'flex', alignItems: 'center', gap: 9,
  width: '100%', padding: '7px 10px', border: 'none', borderRadius: 10, cursor: 'pointer', color: theme.text,
};
function dot(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: color, border: `0.5px solid ${themeAlpha.ink(0.45)}` };
}
