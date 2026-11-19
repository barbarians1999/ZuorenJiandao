import { Icon, type IconName } from '../components/icons';

interface AddSolidCanvasCardProps {
  label: string;
  icon?: IconName;
  onAdd: () => void;
}

export function AddSolidCanvasCard({ label, icon = 'image', onAdd }: AddSolidCanvasCardProps) {
  return (
    <button
      type="button"
      className="cc-add-solid-canvas-card"
      aria-label={label}
      title={label}
      onClick={onAdd}
    >
      <span className="cc-media-entry-thumb cc-add-solid-canvas-thumb">
        <Icon name={icon} size={20} strokeWidth={1.4} />
      </span>
      <span className="cc-media-entry-name">{label}</span>
    </button>
  );
}
