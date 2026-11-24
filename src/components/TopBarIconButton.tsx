import type { ReactNode } from 'react';
import { theme } from '../theme';
import { Icon, type IconName } from './icons';

interface TopBarIconButtonProps {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  badge?: ReactNode;
}

/** Shared right-side top-bar icon button: instant tooltip and consistent hover feedback. */
export function TopBarIconButton({ icon, label, onClick, disabled = false, pressed, badge }: TopBarIconButtonProps) {
  return (
    <button
      type="button"
      className="cc-topbar-icon-button cc-tip cc-tip-r"
      data-tip={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      style={{ position: 'relative', width: 36, height: 36, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 6, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim, opacity: disabled ? 0.35 : 1 }}
      onMouseEnter={(event) => {
        if (!disabled) {
          event.currentTarget.style.color = theme.text;
          event.currentTarget.style.background = theme.panelAlt;
        }
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = theme.textDim;
        event.currentTarget.style.background = 'none';
      }}
    >
      <Icon name={icon} size={19} />
      <span className="cc-tool-label">{label}</span>
      {badge}
    </button>
  );
}
