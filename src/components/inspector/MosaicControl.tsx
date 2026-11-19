import type { AspectFit, ClipEffect, TimelineItem } from '../../editor/types';
import { clearMosaicTrack, DEFAULT_MOSAIC, GAUSSIAN_MOSAIC_ID, mosaicTrackRegionToStatic, readMosaicAt, setMosaicMode, setMosaicRegion, type MosaicRegion } from '../../editor/mosaic';
import { useT } from '../../i18n/locale';
import { SliderRow } from './InspectorKeyframeControls';
import './clip-region-controls.css';

export function MosaicControl({ item, localFrame, fit, canvasWidth, canvasHeight, onChange }: {
  item: TimelineItem; localFrame: number; fit: AspectFit; canvasWidth: number; canvasHeight: number;
  onChange: (effects: ClipEffect[]) => void;
}) {
  const t = useT(), effects = item.effects ?? [];
  const { mode, region, count, legacyCount } = readMosaicAt(item, localFrame);
  const id = () => `fx_mosaic_${crypto.randomUUID()}`;
  const update = (patch: Partial<MosaicRegion>) => {
    const preserveTrack = Object.keys(patch).every((key) => key === 'strength' || key === 'feather');
    const next = { ...region, ...patch };
    onChange(setMosaicRegion(effects, preserveTrack ? next
      : mosaicTrackRegionToStatic(item, next, fit, { width: canvasWidth, height: canvasHeight }), id(), preserveTrack));
  };
  const track = effects.find((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID)?.mosaicTrack;
  const fields = [
    { key: 'centerX', label: '水平位置' }, { key: 'centerY', label: '垂直位置' },
    { key: 'width', label: '打码宽度' }, { key: 'height', label: '打码高度' },
  ] as const;
  return <div className="cc-clip-region-control">
    <div className="cc-region-presets" aria-label={t('马赛克范围')}>
      {(['none', 'local', 'full'] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value}
        onClick={() => onChange(setMosaicMode(effects, value, id()))}>
        <span className={`cc-region-sample mosaic-${value}`} aria-hidden="true" />
        {t({ none: '无', local: '局部打码', full: '全屏打码' }[value])}
      </button>)}
    </div>
    <p className="cc-region-note">{t('高斯模糊用于柔化和遮挡画面内容；不影响声音。请确认敏感内容已看不清。')}</p>
    {legacyCount > 0 && <p className="cc-region-note">{t('旧版像素格效果仍保留，不会自动改成模糊。选择“无”将清除所有打码效果。')}</p>}
    {mode !== 'none' && <>
      {count > 1 && <p className="cc-region-note">{t('已有 {n} 处打码；本面板调整第一处，其余保持不变。', { n: count })}</p>}
      <SliderRow label={t('模糊强度')} val={region.strength} min={1} max={100} step={1} fmt={`${region.strength}`}
        onChange={(strength) => update({ strength })} onReset={() => update({ strength: DEFAULT_MOSAIC.strength })} />
      {mode === 'local' && fields.map(({ key, label }) => <SliderRow key={key} label={t(label)} val={region[key]}
        min={key === 'width' || key === 'height' ? .01 : 0} max={1} step={.01}
        fmt={`${Math.round(region[key] * 100)}%`} inputScale={100} onChange={(value) => update({ [key]: value })}
        onReset={() => update({ [key]: DEFAULT_MOSAIC[key] })} />)}
      {mode === 'local' && <SliderRow label={t('边缘羽化')} val={region.feather} min={0} max={100} step={1}
        fmt={`${Math.round(region.feather)} px`} onChange={(feather) => update({ feather })} onReset={() => update({ feather: 0 })} />}
      <p className="cc-region-note">{t('局部位置相对于片段画面；边缘羽化会减少边缘的遮挡。请检查是否完整覆盖需打码内容。')}</p>
      {track && <>
        <p className="cc-region-note">{t('重复纹理或遮挡可能导致轨迹漂移；应用前请检查路径。调整区域会清除跟踪；超出跟踪范围时保持端点。目标被裁切到画面边缘时，打码边缘会变硬。')}</p>
        <button type="button" onClick={() => onChange(clearMosaicTrack(item,
          Math.max(0, Math.min(item.durationInFrames - 1, localFrame)), id(), fit,
          { width: canvasWidth, height: canvasHeight }))}
          style={{ alignSelf: 'flex-start', padding: '6px 9px', borderRadius: 5, border: '1px solid var(--cc-border)',
            background: 'var(--cc-panel)', color: 'var(--cc-text)', cursor: 'pointer' }}>
          {t('清除跟踪')}
        </button>
      </>}
    </>}
  </div>;
}
