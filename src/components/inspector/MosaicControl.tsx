import type { AspectFit, ClipEffect, TimelineItem } from '../../editor/types';
import {
  DEFAULT_MOSAIC,
  addClipMosaic,
  clearClipMosaicTrackById,
  listClipMosaics,
  mosaicTrackRegionToStatic,
  removeClipMosaicById,
  updateClipMosaicById,
  type MosaicRegion,
} from '../../editor/mosaic';
import { useT } from '../../i18n/locale';
import { SliderRow } from './InspectorKeyframeControls';
import './clip-region-controls.css';

export function MosaicControl({
  item,
  localFrame = 0,
  fit = 'contain',
  canvasWidth = 1,
  canvasHeight = 1,
  selectedEffectId = null,
  onSelectEffect,
  onChange,
}: {
  item: TimelineItem;
  localFrame?: number;
  fit?: AspectFit;
  canvasWidth?: number;
  canvasHeight?: number;
  selectedEffectId?: string | null;
  onSelectEffect?: (effectId: string | null) => void;
  onChange: (effects: ClipEffect[]) => void;
}) {
  const t = useT();
  const effects = item.effects ?? [];
  const mosaics = listClipMosaics(item, localFrame);
  const active = mosaics.find((entry) => entry.id === selectedEffectId) ?? mosaics[0] ?? null;

  const addNewMosaic = () => {
    const newId = `fx_mosaic_${crypto.randomUUID()}`;
    onChange(addClipMosaic(effects, newId, { style: 'gaussian', mode: 'local' }));
    onSelectEffect?.(newId);
  };

  const removeActiveMosaic = () => {
    if (!active) return;
    const activeIdx = mosaics.findIndex((entry) => entry.id === active.id);
    const nextFallback = mosaics[activeIdx + 1]?.id ?? mosaics[activeIdx - 1]?.id ?? null;
    onChange(removeClipMosaicById(effects, active.id));
    onSelectEffect?.(nextFallback);
  };

  const updateRegion = (patch: Partial<MosaicRegion>) => {
    if (!active) return;
    const preserveTrack = Object.keys(patch).every((key) => key === 'strength' || key === 'feather');
    const next = { ...active.region, ...patch };
    const resolved = preserveTrack
      ? next
      : mosaicTrackRegionToStatic(item, next, fit, { width: canvasWidth, height: canvasHeight }, active.id);
    onChange(updateClipMosaicById(effects, active.id, { region: resolved, preserveTrack }));
  };

  const fields = [
    { key: 'centerX', label: '水平位置' },
    { key: 'centerY', label: '垂直位置' },
    { key: 'width', label: '打码宽度' },
    { key: 'height', label: '打码高度' },
  ] as const;

  return (
    <div className="cc-clip-region-control">
      <div className="cc-mosaic-list" role="group" aria-label={t('马赛克列表')}>
        {mosaics.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="cc-mosaic-chip"
            data-mosaic-chip={entry.id}
            aria-pressed={entry.id === active?.id}
            onClick={() => onSelectEffect?.(entry.id)}
          >
            {t('马赛克 {n}', { n: entry.index })}
          </button>
        ))}
        <button type="button" className="cc-mosaic-add-btn" onClick={addNewMosaic}>
          {t('＋ 添加马赛克')}
        </button>
      </div>

      {!active ? (
        <p className="cc-region-note">
          {t('尚未添加马赛克。点击“＋ 添加马赛克”后，可在预览画面直接拖动位置并拉伸边角调整大小。')}
        </p>
      ) : (
        <>
          <div className="cc-mosaic-active-header">
            <span className="cc-mosaic-active-title">{t('马赛克 {n}', { n: active.index })}</span>
            <button type="button" className="cc-mosaic-remove-btn" onClick={removeActiveMosaic}>
              {t('删除')}
            </button>
          </div>

          <div className="cc-mosaic-style-switch" role="group" aria-label={t('马赛克样式')}>
            {(['gaussian', 'pixel'] as const).map((style) => (
              <button
                key={style}
                type="button"
                aria-pressed={active.style === style}
                onClick={() => onChange(updateClipMosaicById(effects, active.id, { style }))}
              >
                {t(style === 'gaussian' ? '高斯模糊' : '像素马赛克')}
              </button>
            ))}
          </div>

          <div className="cc-region-presets is-two-col" aria-label={t('马赛克范围')}>
            {(['local', 'full'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={active.mode === mode}
                onClick={() => onChange(updateClipMosaicById(effects, active.id, { mode }))}
              >
                <span className={`cc-region-sample mosaic-${mode}`} aria-hidden="true" />
                {t(mode === 'local' ? '局部打码' : '全屏打码')}
              </button>
            ))}
          </div>

          {active.style === 'gaussian' ? (
            <SliderRow
              label={t('模糊强度')}
              val={active.region.strength}
              min={1}
              max={100}
              step={1}
              fmt={`${active.region.strength}`}
              onChange={(strength) => updateRegion({ strength })}
              onReset={() => updateRegion({ strength: DEFAULT_MOSAIC.strength })}
            />
          ) : (
            <SliderRow
              label={t('块大小')}
              val={active.blockSize}
              min={active.mode === 'full' ? 2 : 1}
              max={active.mode === 'full' ? 80 : 200}
              step={1}
              fmt={`${Math.round(active.blockSize)}`}
              onChange={(blockSize) => onChange(updateClipMosaicById(effects, active.id, { blockSize }))}
              onReset={() => onChange(updateClipMosaicById(effects, active.id, { blockSize: active.mode === 'full' ? 12 : 20 }))}
            />
          )}

          {active.mode === 'local' && fields.map(({ key, label }) => (
            <SliderRow
              key={key}
              label={t(label)}
              val={active.region[key]}
              min={key === 'width' || key === 'height' ? .01 : 0}
              max={1}
              step={.01}
              fmt={`${Math.round(active.region[key] * 100)}%`}
              inputScale={100}
              onChange={(value) => updateRegion({ [key]: value })}
              onReset={() => updateRegion({ [key]: active.style === 'pixel' && (key === 'width' || key === 'height') ? .2 : DEFAULT_MOSAIC[key] })}
            />
          ))}

          {active.mode === 'local' && (
            <SliderRow
              label={t('边缘羽化')}
              val={active.region.feather}
              min={0}
              max={100}
              step={1}
              fmt={`${Math.round(active.region.feather)} px`}
              onChange={(feather) => updateRegion({ feather })}
              onReset={() => updateRegion({ feather: active.style === 'pixel' ? 4 : 0 })}
            />
          )}

          {active.tracked && (
            <button
              type="button"
              onClick={() => onChange(clearClipMosaicTrackById(
                item,
                active.id,
                Math.max(0, Math.min(item.durationInFrames - 1, localFrame)),
                fit,
                { width: canvasWidth, height: canvasHeight },
              ))}
              style={{
                alignSelf: 'flex-start',
                padding: '6px 9px',
                borderRadius: 5,
                border: '1px solid var(--cc-border)',
                background: 'var(--cc-panel)',
                color: 'var(--cc-text)',
                cursor: 'pointer',
              }}
            >
              {t('清除跟踪')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
