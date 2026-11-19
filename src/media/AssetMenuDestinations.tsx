import { useT } from '../i18n/locale';
import { Icon } from '../components/icons';

interface AssetMenuDestinationsProps {
  assetName: string;
  onAddTimeline?: () => void;
}

export function AssetMenuDestinations({
  assetName,
  onAddTimeline,
}: AssetMenuDestinationsProps) {
  const t = useT();

  return (
    <div className="cc-asset-menu-destinations">
      <span>{t('添加到：')}</span>
      <div className="cc-asset-menu-destination-buttons">
        {onAddTimeline && <button
          type="button"
          className="cc-media-menu-item"
          role="menuitem"
          aria-label={t('添加 {name} 到时间线', { name: assetName })}
          onClick={onAddTimeline}
        >
          <span className="cc-media-menu-item-icon" aria-hidden="true"><Icon name="film" size={15} /></span>
          <span className="cc-media-menu-item-label">{t('时间线')}</span>
        </button>}
      </div>
    </div>
  );
}
