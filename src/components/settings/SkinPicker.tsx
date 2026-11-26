// Theme switcher: Night/Day mode segmented switch + 4 design-language families
// Preview + name + tagline + check mark. Takes effect immediately via applySkin (<html data-cc-skin>),
// persisted in localStorage; shared between Dashboard and Editor TopBar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
        style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 2101 }}
      >
        <div className="cc-skin-picker-head">
          <span className="cc-skin-picker-head-label">{t('界面主题')}</span>
          <div role="group" aria-label={t('日间或夜间模式')} className="cc-skin-picker-mode-group">
            <button
              type="button"
              aria-pressed={activeDef.mode === 'dark'}
              onClick={() => pickMode('dark')}
              className={`cc-skin-picker-mode-btn${activeDef.mode === 'dark' ? ' is-active' : ''}`}
            >
              <Icon name="moon" size={12} />
              <span>{t('夜间')}</span>
            </button>
            <button
              type="button"
              aria-pressed={activeDef.mode === 'light'}
              onClick={() => pickMode('light')}
              className={`cc-skin-picker-mode-btn${activeDef.mode === 'light' ? ' is-active' : ''}`}
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
              data-skin-family={family.id}
              onClick={() => pickFamily(family.id)}
              className={`cc-skin-picker-option${active ? ' is-active' : ''}`}
            >
              <span className="cc-skin-picker-swatches">
                <span className="cc-skin-picker-dot" style={{ background: target.tokens.bg }} />
                <span className="cc-skin-picker-dot" style={{ background: target.tokens.panelAlt }} />
                <span className="cc-skin-picker-dot" style={{ background: target.tokens.accent }} />
              </span>
              <span className="cc-skin-picker-copy">
                <span className="cc-skin-picker-name">
                  {t(family.nameZh)}
                </span>
                <span className="cc-skin-picker-tagline">
                  {t(family.taglineZh)}
                </span>
              </span>
              {active && (
                <span className="cc-skin-picker-check">
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
        className={`cc-topbar-icon-button cc-skin-picker-trigger cc-tip cc-tip-r${open ? ' is-open' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="brush" size={19} />
      </button>
      {overlay && (typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay)}
    </div>
  );
}
