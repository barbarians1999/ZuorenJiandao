import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/locale';
import { Icon } from './icons';

/** Low-frequency app utilities, separate from the always-visible editing tools. */
export function ToolbarUtilities({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="cc-toolbar-utilities" ref={root} data-cc-titlebar-control="true"
    onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" ref={trigger} className="cc-utilities-trigger" aria-label={t('应用工具')}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <Icon name="grid" size={18} /><span>{t('应用工具')}</span>
    </button>
    {open && <div className="cc-utilities-popover" id={id} aria-label={t('应用工具')}
      onClick={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.hasAttribute('aria-expanded')) {
          // Make dialog focus-return target the persistent trigger, not an unmounted menu item.
          trigger.current?.focus();
          setOpen(false);
        }
      }}>
      {children}
    </div>}
  </div>;
}
