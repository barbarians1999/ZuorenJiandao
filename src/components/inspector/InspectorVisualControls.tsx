import { type ReactNode } from 'react';
import './InspectorVisualControls.css';
import './clip-region-controls.css';
import { theme } from '../../theme';
import type { ClipEffect, ClipEffectValue, ClipFilters, ClipMask, TimelineItem } from '../../editor/types';
import { DEFAULT_CLIP_MASK } from '../../editor/clipMask';
import {
  ALL_FX as FX_EFFECTS,
  FX_IDS as SHADER_FX_IDS,
  LUT_EFFECTS,
  LUT_IDS,
} from '../../gl/fx/effects';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import { useT } from '../../i18n/locale';
import { sampleKeyframes } from '../../editor/keyframes';
import type { KfApi } from './InspectorKeyframeControls';
import { ColorParamInput, KfCell, SliderRow } from './InspectorKeyframeControls';
import type { AutoGradeControlProps } from './InspectorTypes';
import { PreviewFidelityStatus } from './PreviewFidelityStatus';
export { BackgroundFillControl } from './BackgroundFillControl';

const SHADER_FX_SET = new Set<string>(SHADER_FX_IDS);
const LUT_FX_SET = new Set<string>(LUT_IDS);
const compactNumber = (value: number) => String(Number(value.toFixed(2)));

function EffectParamRange({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (next: number) => void;
}) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
      <div style={{ marginBottom: 4 }}>{label} <span style={{ opacity: 0.7 }}>{display}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
    </label>
  );
}

// small uppercase-ish divider label between control groups.
export function SectionLabel({
  children, onReset, resetDisabled,
}: {
  children: ReactNode;
  onReset?: () => void;
  resetDisabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="cc-insp-section">
      <span>{children}</span>
      {onReset && (
        <button
          className="cc-insp-group-reset"
          disabled={resetDisabled}
          title={t('重置整个分组')}
          type="button"
          onClick={onReset}
        >
          {t('重置')}
        </button>
      )}
    </div>
  );
}

// brightness / contrast / saturation / blur implemented with CSS filters.
export function FilterControl({ item, mixed, onChange, autoGrade }: {
  item: TimelineItem;
  mixed?: Partial<Record<keyof ClipFilters, boolean>>;
  onChange: (p: ClipFilters) => void;
  autoGrade?: AutoGradeControlProps;
}) {
  const t = useT();
  const fl: ClipFilters = { ...item.filters, ...(autoGrade?.selectedPreview?.filters ?? {}) };
  return (
    <div className="cc-insp-stack">
      {autoGrade && (
        <div className={`cc-auto-grade${autoGrade.previewCount ? ' previewing' : ''}`}>
          <div className="cc-auto-grade-head">
            <div>
              <strong>{t('自动校色')}</strong>
            </div>
            <button
              type="button"
              className="cc-insp-btn"
              disabled={autoGrade.busy || autoGrade.targetCount === 0}
              onClick={() => void autoGrade.onAnalyze()}
            >
              {autoGrade.busy ? t('分析中…') : t('分析选中片段')}
            </button>
          </div>
          {autoGrade.targetCount === 0 && (
            <div className="cc-auto-grade-note">{t('请先选中视频或图片片段')}</div>
          )}
          {autoGrade.previewCount > 0 && (
            <div className="cc-auto-grade-result">
              <div>
                <b>{t('预览中 · {n} 个片段', { n: autoGrade.previewCount })}</b>
                {autoGrade.failedCount > 0 && <span>{t(' · {n} 个失败', { n: autoGrade.failedCount })}</span>}
                {autoGrade.selectedPreview && (
                  <span>
                    {` · ${autoGrade.selectedPreview.bitDepth}-bit${autoGrade.selectedPreview.hdr ? ' HDR' : ' SDR'}`}
                    {` · ${Math.round(autoGrade.selectedPreview.filters.brightness * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.contrast * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.saturate * 100)}%`}
                  </span>
                )}
              </div>
              <div className="cc-insp-actions">
                <button type="button" className="cc-insp-btn primary" onClick={autoGrade.onApply}>{t('应用校色')}</button>
                <button type="button" className="cc-insp-btn" onClick={autoGrade.onCancel}>{t('取消预览')}</button>
              </div>
            </div>
          )}
        </div>
      )}
      <SliderRow label={t('亮度')} val={fl.brightness ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.brightness ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.brightness}
        onReset={() => onChange({ brightness: 1 })} resetDisabled={Math.abs((fl.brightness ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ brightness: v })} />
      <SliderRow label={t('对比')} val={fl.contrast ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.contrast ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.contrast}
        onReset={() => onChange({ contrast: 1 })} resetDisabled={Math.abs((fl.contrast ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ contrast: v })} />
      <SliderRow label={t('饱和')} val={fl.saturate ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.saturate ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.saturate}
        onReset={() => onChange({ saturate: 1 })} resetDisabled={Math.abs((fl.saturate ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ saturate: v })} />
      <SliderRow label={t('模糊')} val={fl.blur ?? 0} min={0} max={30} step={1} fmt={`${compactNumber(fl.blur ?? 0)}px`} mixed={mixed?.blur}
        onReset={() => onChange({ blur: 0 })} resetDisabled={(fl.blur ?? 0) === 0} onChange={(v) => onChange({ blur: v })} />
    </div>
  );
}

/** Rectangle/ellipse mask. Geometry is normalized to the composition and can
 * use the same local-frame keyframe rail as ordinary transform channels. */
export function MaskControl({ item, mixed, onChange, onReset, kf }: {
  item: TimelineItem;
  mixed?: Partial<Record<'type' | 'x' | 'y' | 'width' | 'height' | 'feather', boolean>>;
  onChange: (mask: ClipMask | null) => void;
  onReset: (props: readonly ('maskX' | 'maskY' | 'maskWidth' | 'maskHeight' | 'maskFeather')[]) => void;
  kf: KfApi;
}) {
  const t = useT();
  const active = item.mask ?? DEFAULT_CLIP_MASK;
  const update = (patch: Partial<ClipMask>) => onChange({
    ...(mixed?.type || !item.mask ? DEFAULT_CLIP_MASK : item.mask),
    ...patch,
  });
  const rows: ReadonlyArray<{ key: 'x' | 'y' | 'width' | 'height' | 'feather'; prop: 'maskX' | 'maskY' | 'maskWidth' | 'maskHeight' | 'maskFeather'; label: string; min: number; max: number; step: number; defaultValue: number }> = [
    { key: 'x', prop: 'maskX', label: t('左侧'), min: 0, max: 1, step: 0.01, defaultValue: 0 },
    { key: 'y', prop: 'maskY', label: t('顶部'), min: 0, max: 1, step: 0.01, defaultValue: 0 },
    { key: 'width', prop: 'maskWidth', label: t('宽度'), min: 0.001, max: 1, step: 0.01, defaultValue: 1 },
    { key: 'height', prop: 'maskHeight', label: t('高度'), min: 0.001, max: 1, step: 0.01, defaultValue: 1 },
    { key: 'feather', prop: 'maskFeather', label: t('羽化'), min: 0, max: 0.5, step: 0.005, defaultValue: 0 },
  ];
  const row = (definition: typeof rows[number]) => {
    const kfs = item.keyframes?.[definition.prop];
    const base = active[definition.key] ?? definition.defaultValue;
    const value = kfs?.length ? sampleKeyframes(kfs, kf.localFrame) : base;
    const mixedValue = mixed?.[definition.key];
    return (
      <div key={definition.prop} className="cc-insp-control-line">
        <div style={{ flex: 1, minWidth: 0 }}>
          <SliderRow
            label={definition.label}
            val={value}
            mixed={mixedValue}
            min={definition.min}
            max={definition.max}
            step={definition.step}
            fmt={`${Math.round(value * 100)}%`}
            inputScale={100}
            disabled={!!kfs?.length && !kf.inRange}
            disabledReason={t('把播放头移进这个片段才能改这里的关键帧')}
            onReset={() => kfs?.length ? onReset([definition.prop]) : update({ [definition.key]: definition.defaultValue })}
            resetDisabled={!mixedValue && !kfs?.length && (!item.mask || Math.abs(base - definition.defaultValue) < 1e-6)}
            onChange={(next) => {
              if (!kfs?.length) update({ [definition.key]: next });
              else if (kf.inRange) kf.set(definition.prop, kf.localFrame, next);
            }}
          />
        </div>
        <KfCell kfs={kfs} localFrame={kf.localFrame} inRange={kf.inRange} punchValue={value}
          onSet={(frame, next, easing) => kf.set(definition.prop, frame, next, easing)}
          onRemove={(frame) => kf.remove(definition.prop, frame)} onSeekLocal={kf.seekLocal} />
      </div>
    );
  };
  return (
    <div className="cc-clip-region-control">
      <div className="cc-region-presets" aria-label={t('蒙版形状')}>
        {(['none', 'rectangle', 'ellipse'] as const).map((type) => <button key={type} type="button"
          aria-pressed={!mixed?.type && (item.mask?.type ?? 'none') === type}
          onClick={() => type === 'none' ? onChange(null) : onChange({
            ...(mixed?.type || !item.mask ? { ...DEFAULT_CLIP_MASK, x: .2, y: .2, width: .6, height: .6 } : item.mask), type,
          })}>
          <span className={`cc-region-sample mask-${type}`} aria-hidden="true" />
          {t({ none: '无', rectangle: '矩形', ellipse: '椭圆' }[type])}
        </button>)}
      </div>
      {mixed?.type && <p className="cc-region-note">{t('所选片段的蒙版不同，点击形状统一应用。')}</p>}
      {item.mask && rows.map(row)}
    </div>
  );
}



// Per-clip WebGL effect stack (effects / builtin:fx-*). Order is render
// order: each card consumes the previous card's output.
export function EffectsControl({ item, onChange, previewStatus }: { item: TimelineItem; onChange: (effects: ClipEffect[]) => void; previewStatus?: SelectedPreviewStatus }) {
  const t = useT();
  const effects = item.effects ?? [];
  const active = effects.filter((fx) => fx.assetId in FX_EFFECTS);
  const customFxIds = Object.keys(FX_EFFECTS).filter((id) => !SHADER_FX_SET.has(id) && !LUT_FX_SET.has(id));
  const addEffect = (assetId: string) => {
    if (assetId) onChange([...effects, { id: `fx_${crypto.randomUUID()}`, assetId, overrides: {} }]);
  };
  const updateEffect = (id: string, patch: Partial<ClipEffect>) => onChange(effects.map((fx) => fx.id === id ? { ...fx, ...patch } : fx));
  const setParam = (effect: ClipEffect, key: string, value: ClipEffectValue) => {
    updateEffect(effect.id, { overrides: { ...effect.overrides, [key]: value } });
  };
  const moveEffect = (index: number, delta: number) => {
    const other = active[index + delta];
    if (!other) return;
    const from = effects.findIndex((fx) => fx.id === active[index].id);
    const to = effects.findIndex((fx) => fx.id === other.id);
    const next = [...effects];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  const fmt = (step: number | undefined, v: number) => (step && step < 1 ? v.toFixed(2) : String(Math.round(v)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <select value="" onChange={(e) => addEffect(e.target.value)}
        style={{ width: '100%', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '5px 7px', fontSize: 12 }}>
        <option value="">{t('＋ 添加特效或 LUT…')}</option>
        <optgroup label={t('画面特效')}>
          {SHADER_FX_IDS.map((id) => <option key={id} value={id}>{t(FX_EFFECTS[id].name)}</option>)}
        </optgroup>
        <optgroup label={t('调色 LUT')}>
          {LUT_IDS.map((id) => <option key={id} value={id}>{t(LUT_EFFECTS[id].name)}</option>)}
        </optgroup>
        {customFxIds.length > 0 && (
          <optgroup label={t('扩展特效')}>
            {customFxIds.map((id) => <option key={id} value={id}>{t(FX_EFFECTS[id].name)}</option>)}
          </optgroup>
        )}
      </select>
      {active.length === 0 && <div style={{ fontSize: 10.5, color: theme.textDim }}>{t('尚未添加特效。')}</div>}
      {active.length > 0 && <PreviewFidelityStatus status={previewStatus} />}
      {active.map((effect, index) => {
        const def = FX_EFFECTS[effect.assetId];
        return (
          <div key={effect.id} style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.text }}>
              <b style={{ flex: 1 }}>{index + 1}. {t(def.name)}
                {effect.assetId in LUT_EFFECTS && <span style={{ fontSize: 9, fontWeight: 700, color: theme.textDim, border: `0.5px solid ${theme.border}`, borderRadius: 3, padding: '0 3px', marginLeft: 5, verticalAlign: 'middle' }}>LUT</span>}
              </b>
              <button title={t('上移')} disabled={index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
              <button title={t('下移')} disabled={index === active.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
              <button title={t('移除特效')} onClick={() => onChange(effects.filter((fx) => fx.id !== effect.id))}>×</button>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.75, lineHeight: 1.4 }}>{t(def.desc)}</div>
            {def.props.map((p) => {
              const raw = effect.overrides?.[p.key] ?? p.default;
              if (p.kind === 'color') {
                const value = Array.isArray(raw) ? raw : p.default;
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: theme.textDim }}>
                    {t(p.label)}
                    <ColorParamInput value={value} onPick={(rgb) => setParam(effect, p.key, rgb)} />
                  </label>
                );
              }
              const value = typeof raw === 'number' ? raw : p.default;
              return (
                <EffectParamRange
                  key={p.key}
                  label={t(p.label)}
                  min={p.min}
                  max={p.max}
                  step={p.step ?? 0.01}
                  value={value}
                  display={fmt(p.step, value)}
                  onChange={(next) => setParam(effect, p.key, next)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

