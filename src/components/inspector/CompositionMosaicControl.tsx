import type { CompositionMosaic } from '../../editor/compositionMosaic';
import { DEFAULT_COMPOSITION_MOSAIC, parseCompositionMosaic } from '../../editor/compositionMosaic';
import { useT } from '../../i18n/locale';
import { SectionLabel } from './InspectorVisualControls';
import { SliderRow } from './InspectorKeyframeControls';
import './clip-region-controls.css';

export function CompositionMosaicControl({ value, onChange }: {
  value: unknown;
  onChange: (patch: Partial<CompositionMosaic>) => void;
}) {
  const t = useT();
  const region = parseCompositionMosaic(value);
  if (!region) return <p className="cc-region-note" role="alert">{t('此独立马赛克的区域参数无效，未显示未支持的编辑器。')}</p>;
  const sizeControl = (key: 'width' | 'height', label: string) => <SliderRow
    key={key} label={t(label)} val={region[key]} min={.01} max={1} step={.01}
    fmt={`${Math.round(region[key] * 100)}%`} inputScale={100}
    onChange={(value) => onChange({ [key]: value })}
    onReset={() => onChange({ [key]: DEFAULT_COMPOSITION_MOSAIC[key] })}
  />;
  return <div className="cc-clip-region-control">
    <SectionLabel>{t('独立马赛克区域')}</SectionLabel>
    <label className="cc-insp-row">
      <span className="cc-insp-label">{t('形状')}</span>
      <select aria-label={t('马赛克形状')} value={region.shape}
        onChange={(event) => onChange({ shape: event.target.value as CompositionMosaic['shape'] })}>
        <option value="rectangle">{t('矩形')}</option>
        <option value="ellipse">{t('椭圆')}</option>
      </select>
    </label>
    {sizeControl('width', '区域宽度')}
    {sizeControl('height', '区域高度')}
    <SliderRow label={t('马赛克强度')} val={region.strength} min={1} max={100} step={1} fmt={`${Math.round(region.strength)}`}
      onChange={(strength) => onChange({ strength })}
      onReset={() => onChange({ strength: DEFAULT_COMPOSITION_MOSAIC.strength })} />
    <SliderRow label={t('内侧羽化')} val={region.feather} min={0} max={100} step={1} fmt={`${Math.round(region.feather)} px`}
      onChange={(feather) => onChange({ feather })} onReset={() => onChange({ feather: 0 })} />
    {(region.centerX !== .5 || region.centerY !== .5 || region.opacity !== 1)
      && <p className="cc-region-note">{t('已有区域中心或透明度设置已保留；请用变换中的位置和透明度调整整体效果。')}</p>}
  </div>;
}
