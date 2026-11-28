import { useState } from 'react';
import { theme } from '../../theme';
import type { TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../../editor/types';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import { Icon } from '../icons';
import { SliderRow } from './InspectorKeyframeControls';
import type { FadePatch } from './InspectorTypes';
import { PreviewFidelityStatus } from './PreviewFidelityStatus';
import { resolveTextStyle, TEXT_STYLE_PRESETS, toColorPickerHex, type TextAnchor } from '../../editor/textStyles';
import {
  canAdjustItemSpeed,
  fillToNextFailureMessage,
  formatSpeedSeconds,
  planSpeedForTargetSeconds,
  speedDurationBounds,
  type BatchFillToNextPlan,
} from '../../editor/speedDuration';
import {
  formatFontSizeScale,
  TEXT_DESIGN_PX_DEFAULT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  textPxToScale,
  textScaleToPx,
} from '../../editor/fontSizeScale';
import { FontPicker } from '../../fonts/FontPicker';

const compactNumber = (value: number) => String(Number(value.toFixed(2)));

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

export function IsolateVoiceControl({
  item,
  onIsolate,
}: {
  item: TimelineItem;
  onIsolate: (action: 'apply' | 'clear', strength?: number) => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [strength, setStrength] = useState(item.denoiseStrength ?? 70);
  const active = Boolean(item.denoisedSrc);
  const canApply = Boolean(item.src?.startsWith('/media/uploads/'));

  const run = (action: 'apply' | 'clear', nextStrength?: number) => {
    setBusy(true);
    setErr(null);
    if (action === 'apply') showAppToast(t('正在降低底噪…'), { ms: 60_000 });
    void Promise.resolve(onIsolate(action, nextStrength))
      .then(() => {
        if (action === 'clear') showAppToast(t('已清除降噪'));
        else showAppToast(t('降噪已应用'));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(msg);
        showAppToast(msg, { error: true });
      })
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <SliderRow
        label={t('降噪强度')}
        val={strength}
        min={0}
        max={100}
        step={5}
        fmt={`${Math.round(strength)}`}
        onReset={() => setStrength(70)}
        resetDisabled={strength === 70}
        onChange={setStrength}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          type="button"
          className="cc-insp-btn"
          disabled={busy || !canApply}
          title={!canApply ? t('请先把素材导入媒体池') : t('在本机降低背景底噪，保留原素材')}
          style={{ flex: 1, fontSize: 14 }}
          onClick={() => run('apply', strength)}
        >
          {busy ? t('处理中…') : active ? t('重新降噪') : t('降低底噪')}
        </button>
        {active && (
          <button
            type="button"
            className="cc-insp-btn"
            disabled={busy}
            style={{ fontSize: 14 }}
            onClick={() => run('clear')}
          >
            {t('清除')}
          </button>
        )}
      </div>
      {active && (
        <div className="cc-insp-muted" style={{ fontSize: 14, marginTop: 4 }}>
          {t('已应用降噪')}
        </div>
      )}
      {err && (
        <div style={{ fontSize: 14, color: 'var(--cc-danger, #f66)', marginTop: 4 }}>{err}</div>
      )}
    </div>
  );
}

export function SpeedControl({
  item,
  mixed,
  onChange,
  fps = 30,
  selectedItems,
  onDurationChange,
  fillToNextPlan,
  onFillToNext,
}: {
  item: TimelineItem;
  mixed?: boolean;
  onChange: (rate: number) => void;
  fps?: number;
  selectedItems?: readonly TimelineItem[];
  onDurationChange?: (targetSeconds: number) => void;
  fillToNextPlan?: BatchFillToNextPlan | null;
  onFillToNext?: () => void;
}) {
  const t = useT();
  const selection = selectedItems?.length ? selectedItems : [item];
  const isMulti = selection.length > 1;
  const canSpeed = selection.every(canAdjustItemSpeed);
  const rate = item.playbackRate ?? 1;
  const safeFps = Math.max(1, fps);
  const currentDurationFrames = item.durationInFrames;
  const durationMixed = isMulti && selection.some((entry) => entry.durationInFrames !== currentDurationFrames);
  const formattedCurrentSeconds = formatSpeedSeconds(currentDurationFrames / safeFps);
  const syncKey = `${item.id}:${durationMixed ? '1' : '0'}:${formattedCurrentSeconds}`;
  const defaultDraft = durationMixed ? '' : formattedCurrentSeconds;
  const [draftState, setDraftState] = useState<{ key: string; value: string }>(() => ({
    key: syncKey,
    value: defaultDraft,
  }));
  const durationDraft = draftState.key === syncKey ? draftState.value : defaultDraft;
  const setDurationDraft = (value: string) => setDraftState({ key: syncKey, value });

  const parsedSeconds = Number(durationDraft.trim());
  const validDraft = durationDraft.trim().length > 0 && Number.isFinite(parsedSeconds) && parsedSeconds > 0;
  const bounds = !isMulti ? speedDurationBounds(item, safeFps) : null;
  const previewPlan = !isMulti && validDraft ? planSpeedForTargetSeconds(item, parsedSeconds, safeFps) : null;
  const draftChanged = durationDraft.trim().length > 0
    && (durationMixed || Math.abs(parsedSeconds - currentDurationFrames / safeFps) >= 0.005);
  const canApplyDuration = canSpeed && !!onDurationChange && validDraft;

  const applyDuration = () => {
    if (!canApplyDuration) return;
    onDurationChange(parsedSeconds);
    if (!isMulti && previewPlan && previewPlan.resultingFrames === currentDurationFrames) {
      setDurationDraft(formatSpeedSeconds(previewPlan.resultingFrames / safeFps));
    }
  };

  const singleFillPlan = !isMulti ? fillToNextPlan?.plans[0] : undefined;
  const eligibleCount = fillToNextPlan?.eligible.length ?? 0;
  const totalCount = fillToNextPlan?.total ?? selection.length;
  const isVideoTrack = (fillToNextPlan?.primaryTrackKind ?? 'video') !== 'audio';
  const canFill = canSpeed && !!onFillToNext && eligibleCount > 0;
  const fillButtonLabel = isMulti && eligibleCount > 0 && eligibleCount < totalCount
    ? (isVideoTrack
        ? t('填充至后一视频单元（{eligible}/{total}）', { eligible: eligibleCount, total: totalCount })
        : t('填充至同轨后一片段（{eligible}/{total}）', { eligible: eligibleCount, total: totalCount }))
    : (isVideoTrack ? t('填充至后一视频单元') : t('填充至同轨后一片段'));

  const durationHint = (() => {
    if (!canSpeed) return t('当前片段已启用逐字编辑或不支持变速');
    if (isMulti) return t('将把已选 {n} 个片段统一变速为目标时长', { n: selection.length });
    if (draftChanged && previewPlan) {
      if (previewPlan.clamped) {
        return t('超出 0.1×–8× 范围，将按 {rate}× 调整为 {sec} 秒', {
          rate: compactNumber(previewPlan.rate),
          sec: formatSpeedSeconds(previewPlan.resultingFrames / safeFps),
        });
      }
      return t('将变速为 {rate}×', { rate: compactNumber(previewPlan.rate) });
    }
    if (bounds) {
      return t('当前 {current} 秒 · 可调 {min}–{max} 秒', {
        current: formatSpeedSeconds(bounds.currentSeconds),
        min: formatSpeedSeconds(bounds.minSeconds),
        max: formatSpeedSeconds(bounds.maxSeconds),
      });
    }
    return null;
  })();

  const fillHint = (() => {
    if (!isMulti && singleFillPlan) {
      if (singleFillPlan.ok) {
        if (singleFillPlan.remainingGapFrames > 0) {
          return t('将按最慢 0.10× 拉长至 {result} 秒（仍余 {rem} 秒空隙）', {
            result: formatSpeedSeconds(singleFillPlan.resultingFrames / safeFps),
            rem: formatSpeedSeconds(singleFillPlan.remainingGapFrames / safeFps),
          });
        }
        return t('补齐 {gap} 秒空隙 → {target} 秒（{rate}×）', {
          gap: formatSpeedSeconds(singleFillPlan.gapFrames / safeFps),
          target: formatSpeedSeconds(singleFillPlan.resultingFrames / safeFps),
          rate: compactNumber(singleFillPlan.rate),
        });
      }
      return t(fillToNextFailureMessage(singleFillPlan.reason, singleFillPlan.trackKind));
    }
    if (isMulti) {
      return eligibleCount > 0
        ? t('将为其中 {n} 个有空隙的片段变速填满至后一片段', { n: eligibleCount })
        : t('所选片段后方均无可填充空隙');
    }
    return null;
  })();

  return (
    <div className="cc-insp-stack">
      <SliderRow
        label={t('变速')}
        val={rate}
        mixed={mixed}
        min={0.25}
        max={4}
        step={0.05}
        fmt={`${rate.toFixed(2)}×`}
        disabled={!canSpeed}
        disabledReason={!canSpeed ? t('当前片段已启用逐字编辑或不支持变速') : undefined}
        onReset={() => onChange(1)}
        resetDisabled={!canSpeed || (!mixed && Math.abs(rate - 1) < 1e-6)}
        onChange={onChange}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            className="cc-insp-btn"
            disabled={!canSpeed}
            style={{
              fontSize: 10,
              padding: '2px 6px',
              opacity: !canSpeed ? 0.45 : Math.abs(rate - s) < 0.01 ? 1 : 0.7,
              fontWeight: Math.abs(rate - s) < 0.01 ? 700 : 400,
            }}
            onClick={() => onChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      {onDurationChange && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, marginTop: 4, borderTop: '0.5px solid var(--cc-border)' }}>
          <div className="cc-insp-row">
            <label className="cc-insp-label" htmlFor={`speed-duration-${item.id}`}>{t('变速成')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              <input
                id={`speed-duration-${item.id}`}
                data-testid="inspector-speed-duration-input"
                className="cc-insp-number"
                type="number"
                min={0.05}
                step={0.1}
                disabled={!canSpeed}
                value={durationDraft}
                placeholder={durationMixed ? '—' : undefined}
                aria-label={t('目标时长（秒）')}
                style={{ width: 68, flex: '0 0 auto' }}
                onChange={(event) => setDurationDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyDuration();
                  }
                }}
              />
              <span className="cc-insp-muted" style={{ fontSize: 11 }}>{t('秒')}</span>
              <button
                type="button"
                data-testid="inspector-speed-duration-apply"
                className="cc-insp-btn"
                disabled={!canApplyDuration}
                style={{ marginLeft: 'auto', fontSize: 11 }}
                onClick={applyDuration}
              >
                {t('应用')}
              </button>
            </div>
          </div>
          {durationHint && (
            <div className="cc-insp-muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
              {durationHint}
            </div>
          )}
        </div>
      )}
      {onFillToNext && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 8, marginTop: 2, borderTop: '0.5px solid var(--cc-border)' }}>
          <button
            type="button"
            data-testid="inspector-speed-fill-next"
            className="cc-insp-btn"
            disabled={!canFill}
            style={{ width: '100%', justifyContent: 'center', fontSize: 11.5 }}
            onClick={onFillToNext}
          >
            <Icon name="rateStretch" size={12} />
            {fillButtonLabel}
          </button>
          {fillHint && (
            <div className="cc-insp-muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
              {fillHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// fade in/out (seconds) — opacity ramp for visual clips, volume ramp for audio.
export function FadeControl({ item, mixed, fps, onChange }: { item: TimelineItem; mixed?: Partial<Record<keyof FadePatch, boolean>>; fps: number; onChange: (f: FadePatch) => void }) {
  const t = useT();
  const maxSec = Math.max(0.1, item.durationInFrames / fps);
  const row = (label: string, frames: number | undefined, key: keyof FadePatch) => {
    const sec = (frames ?? 0) / fps;
    return (
      <SliderRow
        key={key}
        label={label}
        val={sec}
        mixed={mixed?.[key]}
        min={0}
        max={maxSec}
        step={0.1}
        fmt={`${sec.toFixed(1)}s`}
        onReset={() => onChange({ [key]: 0 })}
        resetDisabled={!mixed?.[key] && sec === 0}
        onChange={(v) => onChange({ [key]: Math.round(v * fps) })}
      />
    );
  };
  return (
    <div className="cc-insp-stack">
      {row(t('淡入'), item.fadeInFrames, 'fadeInFrames')}
      {row(t('淡出'), item.fadeOutFrames, 'fadeOutFrames')}
    </div>
  );
}

// text clip content controls (text/fontSize/color/weight/align/typography) — props-backed.
export function TextControl({ item, mixed, onPropChange }: { item: TimelineItem; mixed?: (key: string) => boolean; onPropChange: (key: string, value: unknown) => void }) {
  const t = useT();
  const p = item.props ?? {};
  const style = resolveTextStyle(p);
  const fontScale = textPxToScale(style.fontSize);
  const range = (label: string, key: string, value: number, min: number, max: number, step: number, suffix: string, fallback = 0) => (
    <SliderRow label={label} val={value} min={min} max={max} step={step} fmt={`${value}${suffix}`} mixed={mixed?.(key)}
      onReset={() => onPropChange(key, fallback)} resetDisabled={!mixed?.(key) && Math.abs(value - fallback) < 1e-6}
      onChange={(next) => onPropChange(key, next)} />
  );
  const shadowHex = toColorPickerHex(style.shadowColor, '#000000');
  const bgHex = toColorPickerHex(style.backgroundColor);
  const hasCardBg = style.backgroundOpacity > 0;
  const ensureCardVisible = () => {
    if (!hasCardBg) onPropChange('backgroundOpacity', 88);
    if (style.backgroundPaddingX === 0 && style.backgroundPaddingY === 0) {
      onPropChange('backgroundPaddingX', 20);
      onPropChange('backgroundPaddingY', 12);
      if (style.backgroundRadius === 0) onPropChange('backgroundRadius', 6);
    }
  };
  const anchorFormulaHint = style.anchor === 'top-left'
    ? t('固定左上起点，修改文字长度时左边距保持对齐（悬停按钮可看坐标换算）')
    : style.anchor === 'middle-left'
      ? t('固定左侧垂直居中起点，修改文字长度时左边距保持对齐（悬停按钮可看坐标换算）')
      : null;
  const showCardDetails = hasCardBg || style.accentBarPosition !== 'none';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="cc-insp-row">
        <span className="cc-insp-label">{t('样式预设')}</span>
        <select
          className="cc-insp-select"
          value={typeof p.textStylePreset === 'string' ? p.textStylePreset : ''}
          onChange={(e) => {
            const preset = TEXT_STYLE_PRESETS.find((entry) => entry.id === e.target.value);
            if (!preset) return;
            onPropChange('textStylePreset', preset.id);
            for (const [k, v] of Object.entries(preset.patch)) {
              onPropChange(k, v);
            }
          }}
        >
          <option value="">{t('自定义')}</option>
          {TEXT_STYLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{t(preset.label)}</option>
          ))}
        </select>
      </label>
      <label className="cc-insp-mg-field">
        <span>{t('文字内容')}</span>
        <textarea value={mixed?.('text') ? '' : style.text} placeholder={mixed?.('text') ? '—' : undefined} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          className="cc-insp-textarea"
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cc-inset)', color: theme.text, border: 'none', borderRadius: 12, resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }} />
      </label>
      <div className="cc-insp-row">
        <span className="cc-insp-label">{t('字体')}</span>
        <FontPicker value={typeof p.fontFamily === 'string' ? p.fontFamily : 'sans-serif'}
          targetKey={item.id}
          fontAssetId={typeof p.fontAssetId === 'string' ? p.fontAssetId : undefined}
          mixed={mixed?.('fontFamily') || mixed?.('fontAssetId')}
          onChange={(choice) => { onPropChange('fontFamily', choice.fontFamily); onPropChange('fontAssetId', choice.fontAssetId); }} />
      </div>
      <SliderRow
        label={t('字号')}
        val={fontScale}
        min={TEXT_SCALE_MIN}
        max={TEXT_SCALE_MAX}
        step={TEXT_SCALE_STEP}
        fmt={formatFontSizeScale(fontScale)}
        mixed={mixed?.('fontSize')}
        onReset={() => onPropChange('fontSize', TEXT_DESIGN_PX_DEFAULT)}
        resetDisabled={!mixed?.('fontSize') && Math.abs(style.fontSize - TEXT_DESIGN_PX_DEFAULT) < 0.5}
        onChange={(nextScale) => onPropChange('fontSize', textScaleToPx(nextScale))}
      />
      <div className="cc-insp-row">
        <span className="cc-insp-label">{t('样式对齐')}</span>
        <div className="cc-insp-style-pills">
          <label className="cc-insp-color-chip" title={t('文字颜色')}>
            <span>{t('字色')}</span>
            {mixed?.('color') && <span>—</span>}
            <input type="color" value={style.color} onChange={(e) => onPropChange('color', e.target.value)} />
          </label>
          <div className="cc-insp-segmented" role="group" aria-label={t('对齐')}>
            {(['left', 'center', 'right'] as const).map((align) => (
              <button key={align} type="button" aria-pressed={!mixed?.('align') && style.align === align}
                onClick={() => onPropChange('align', align)}>
                {t(align === 'left' ? '左' : align === 'center' ? '中' : '右')}
              </button>
            ))}
          </div>
          <div className="cc-insp-segmented" role="group" aria-label={t('粗细与样式')}>
            <button type="button" aria-pressed={!mixed?.('fontWeight') && style.fontWeight >= 700}
              title={t('粗体')}
              onClick={() => onPropChange('fontWeight', style.fontWeight >= 700 ? 400 : 700)}>B</button>
            <button type="button" aria-pressed={style.fontStyle === 'italic'}
              title={t('斜体')}
              onClick={() => onPropChange('fontStyle', style.fontStyle === 'italic' ? 'normal' : 'italic')}>I</button>
            <button type="button" aria-pressed={style.textDecoration === 'underline'}
              title={t('下划线')}
              onClick={() => onPropChange('textDecoration', style.textDecoration === 'underline' ? 'none' : 'underline')}>U</button>
          </div>
        </div>
      </div>
      <div className="cc-insp-row">
        <span className="cc-insp-label">{t('定位基准')}</span>
        <div className="cc-insp-segmented" role="group" aria-label={t('定位锚点')}>
          {([
            ['center', '居中', '以画布中心 (50%, 50%) 为原点：X = tx - 50, Y = ty - 50'],
            ['middle-left', '左中固定', '以左中边距 (5%, 50%) 为原点：X = tx - 5, Y = ty - 50'],
            ['top-left', '左上固定', '以左上边距 (5%, 8.9%) 为原点：X = tx - 5, Y = ty - 8.9'],
          ] as ReadonlyArray<readonly [TextAnchor, string, string]>).map(([anchor, label, tip]) => (
            <button key={anchor} type="button" title={t(tip)} aria-pressed={!mixed?.('anchor') && style.anchor === anchor}
              onClick={() => onPropChange('anchor', anchor)}>
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {anchorFormulaHint && (
        <div className="cc-insp-muted" style={{ fontSize: 11, lineHeight: 1.45, paddingInline: 6 }}>{anchorFormulaHint}</div>
      )}
      {range(t('字距'), 'letterSpacing', style.letterSpacing, -10, 40, 1, 'px', 0)}
      {range(t('行距'), 'lineHeight', Number(style.lineHeight.toFixed(2)), 0.6, 3, 0.05, '', 1.2)}
      <div className="cc-insp-collapsible-group">
        <div className="cc-insp-section">{t('描边与阴影')}</div>
        <div className="cc-insp-row">
          <span className="cc-insp-label">{t('描边颜色')}</span>
          <div>
            <label className="cc-insp-color-chip">
              <span>{t('描边')}</span>
              <input type="color" value={style.strokeColor} onChange={(e) => onPropChange('strokeColor', e.target.value)} />
            </label>
          </div>
        </div>
        {range(t('描边宽度'), 'strokeWidth', style.strokeWidth, 0, 30, 1, 'px', 0)}
        <label className="cc-switch-row">
          <span>{t('启用阴影')}</span>
          <input className="cc-switch" type="checkbox" role="switch" checked={style.shadowEnabled} onChange={(e) => onPropChange('shadowEnabled', e.target.checked)} />
        </label>
        {style.shadowEnabled && <div className="cc-insp-stack">
          <div className="cc-insp-row">
            <span className="cc-insp-label">{t('阴影颜色')}</span>
            <div>
              <label className="cc-insp-color-chip">
                <span>{t('阴影色')}</span>
                <input type="color" value={shadowHex} onChange={(e) => onPropChange('shadowColor', e.target.value)} />
              </label>
            </div>
          </div>
          {range(t('阴影不透明'), 'shadowOpacity', style.shadowOpacity, 0, 100, 1, '%', 55)}
          {range(t('模糊'), 'shadowBlur', style.shadowBlur, 0, 80, 1, 'px', 16)}
          {range(t('水平偏移'), 'shadowOffsetX', style.shadowOffsetX, -80, 80, 1, 'px', 0)}
          {range(t('垂直偏移'), 'shadowOffsetY', style.shadowOffsetY, -80, 80, 1, 'px', 3)}
        </div>}
      </div>
      <div className="cc-insp-collapsible-group">
        <div className="cc-insp-section">{t('动态划线（批驳划掉）')}</div>
        <label className="cc-switch-row">
          <span>{t('启用动态划线')}</span>
          <input className="cc-switch" type="checkbox" role="switch" checked={style.strikeAnimated} onChange={(e) => onPropChange('strikeAnimated', e.target.checked)} />
        </label>
        {style.strikeAnimated && <div className="cc-insp-stack">
          <div className="cc-insp-row">
            <span className="cc-insp-label">{t('划线颜色')}</span>
            <div>
              <label className="cc-insp-color-chip">
                <span>{t('划线色')}</span>
                <input type="color" value={style.strikeColor} onChange={(e) => onPropChange('strikeColor', e.target.value)} />
              </label>
            </div>
          </div>
          {range(t('开始时间'), 'strikeStartSec', Number(style.strikeStartSec.toFixed(2)), 0, 15, 0.05, 's', 0.4)}
          {range(t('划过时长'), 'strikeDurationSec', Number(style.strikeDurationSec.toFixed(2)), 0.1, 3, 0.05, 's', 0.35)}
          {range(t('线条粗细'), 'strikeThickness', style.strikeThickness, 2, 24, 1, 'px', 6)}
        </div>}
      </div>
      <div className="cc-insp-collapsible-group">
        <div className="cc-insp-section">{t('背景卡片与装饰条')}</div>
        <label className="cc-switch-row">
          <span>{t('启用背景底色')}</span>
          <input
            className="cc-switch"
            type="checkbox"
            role="switch"
            checked={hasCardBg}
            onChange={(e) => {
              if (e.target.checked) {
                if (!style.backgroundColor) onPropChange('backgroundColor', bgHex);
                onPropChange('backgroundOpacity', 88);
                if (style.backgroundPaddingX === 0 && style.backgroundPaddingY === 0) {
                  onPropChange('backgroundPaddingX', 20);
                  onPropChange('backgroundPaddingY', 12);
                  if (style.backgroundRadius === 0) onPropChange('backgroundRadius', 6);
                }
              } else {
                onPropChange('backgroundOpacity', 0);
              }
            }}
          />
        </label>
        <div className="cc-insp-row">
          <span className="cc-insp-label">{t('强调色条')}</span>
          <div className="cc-insp-segmented" role="group" aria-label={t('强调色条')}>
            {([
              ['none', '无'],
              ['left', '左侧'],
              ['top', '顶部'],
            ] as const).map(([pos, label]) => (
              <button key={pos} type="button" aria-pressed={!mixed?.('accentBarPosition') && style.accentBarPosition === pos}
                onClick={() => {
                  onPropChange('accentBarPosition', pos);
                  if (pos !== 'none') ensureCardVisible();
                }}>
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        {showCardDetails && (
          <div className="cc-insp-stack">
            <div className="cc-insp-row">
              <span className="cc-insp-label">{t('配色')}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="cc-insp-color-chip">
                  <span>{t('背景色')}</span>
                  <input type="color" value={bgHex} onChange={(e) => { onPropChange('backgroundColor', e.target.value); ensureCardVisible(); }} />
                </label>
                {style.accentBarPosition !== 'none' && (
                  <label className="cc-insp-color-chip">
                    <span>{t('装饰条色')}</span>
                    <input type="color" value={toColorPickerHex(style.accentBarColor, '#d4af37')} onChange={(e) => onPropChange('accentBarColor', e.target.value)} />
                  </label>
                )}
              </div>
            </div>
            {range(t('不透明度'), 'backgroundOpacity', style.backgroundOpacity, 0, 100, 1, '%', 0)}
            {range(t('水平内边距'), 'backgroundPaddingX', style.backgroundPaddingX, 0, 160, 1, 'px', 0)}
            {range(t('垂直内边距'), 'backgroundPaddingY', style.backgroundPaddingY, 0, 120, 1, 'px', 0)}
            {range(t('圆角'), 'backgroundRadius', style.backgroundRadius, 0, 120, 1, 'px', 0)}
            {style.accentBarPosition !== 'none' && range(t('色条粗细'), 'accentBarWidth', style.accentBarWidth, 1, 24, 1, 'px', 4)}
          </div>
        )}
      </div>
    </div>
  );
}


// animated zoom (builtin:zoom): shape curve + magnification + focal point,
// plus ReframeCurveV1 sparse keyframes (drop focal+mag at the playhead).
export function ZoomControl({ zoom, mixed, onChange, getLocalFrame, fps, onSetKeyframe, onRemoveKeyframe }: {
  zoom: ZoomEffect | undefined;
  mixed?: Partial<Record<'shape' | 'magnification' | 'focalPointX' | 'focalPointY', boolean>>;
  onChange: (patch: Partial<ZoomEffect> | null) => void;
  getLocalFrame: () => number;
  fps: number;
  onSetKeyframe: (frame: number, fx: number, fy: number, mag: number) => void;
  onRemoveKeyframe: (frame: number) => void;
}) {
  const t = useT();
  const localFrame = getLocalFrame();
  const hasKeyframes = !!zoom?.reframeCurve?.keyframes.length;
  return (
    <div className="cc-insp-stack">
      <label className="cc-insp-row">
        <span className="cc-insp-label">{t('曲线')}</span>
        <select className="cc-insp-select" value={mixed?.shape ? '__mixed' : zoom?.shape ?? ''} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          {mixed?.shape && <option value="__mixed" disabled>—</option>}
          <option value="">{t('无')}</option>
          {ZOOM_SHAPE_ORDER.map((k) => <option key={k} value={k}>{t(ZOOM_SHAPE_LABELS[k])}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          <SliderRow label={t('倍数')} val={zoom.magnification ?? 1.5} min={1} max={4} step={0.05} fmt={`${(zoom.magnification ?? 1.5).toFixed(2)}×`} mixed={mixed?.magnification}
            onReset={() => onChange({ magnification: 1.5, reframeCurve: undefined })} resetDisabled={!mixed?.magnification && !hasKeyframes && Math.abs((zoom.magnification ?? 1.5) - 1.5) < 1e-6}
            onChange={(v) => onChange({ magnification: v })} />
          <SliderRow label={t('焦点X')} val={zoom.focalPointX ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointX ?? 0.5) * 100)}%`} inputScale={100} mixed={mixed?.focalPointX}
            onReset={() => onChange({ focalPointX: 0.5, reframeCurve: undefined })} resetDisabled={!mixed?.focalPointX && !hasKeyframes && Math.abs((zoom.focalPointX ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointX: v })} />
          <SliderRow label={t('焦点Y')} val={zoom.focalPointY ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointY ?? 0.5) * 100)}%`} inputScale={100} mixed={mixed?.focalPointY}
            onReset={() => onChange({ focalPointY: 0.5, reframeCurve: undefined })} resetDisabled={!mixed?.focalPointY && !hasKeyframes && Math.abs((zoom.focalPointY ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointY: v })} />
          <div className="cc-insp-actions">
            <button
              type="button"
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title={t('在播放头记录焦点+倍数为关键帧')}
              className="cc-insp-btn"
            >
              <Icon name="diamond" size={12} />{t('关键帧')}
            </button>
            <span className="cc-insp-muted">@ {(localFrame / fps).toFixed(2)}s</span>
          </div>
          {(zoom.reframeCurve?.keyframes.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>{t('关键帧（覆盖曲线，逐帧插值）')}</div>
              {zoom.reframeCurve!.keyframes.map((k) => (
                <div key={k.frame} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.textDim }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="diamond" size={11} />{(k.frame / fps).toFixed(2)}s</span>
                  <span style={{ opacity: 0.8 }}>{k.magnification.toFixed(2)}× · ({Math.round(k.focalPointX * 100)},{Math.round(k.focalPointY * 100)})</span>
                  <button onClick={() => onRemoveKeyframe(k.frame)} title={t('删除关键帧')} style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}


// transition INTO the selected clip from the previous adjacent same-track clip.
// Picking a type creates it; None removes it.
export function TransitionControl({ transition, fps, onAdd, onSet, onRemove, audioMode, previewStatus }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
  /** true = only audio-cross-fade (trAudioCrossFade) */
  audioMode?: boolean;
  previewStatus?: SelectedPreviewStatus;
}) {
  const t = useT();
  const symmetric = transition?.type === 'blinds-reveal' || transition?.type === 'split-slide';
  const needsDir = transition && (transition.type === 'soft-wipe' || transition.type === 'clean-line-wipe' || transition.type === 'whip-pan' || transition.type === 'archival-line-wipe' || symmetric);
  const options = audioMode ? AUDIO_TRANSITION_ORDER : TRANSITION_ORDER;
  // When audioMode, ignore a visual transition on this clip (shouldn't exist)
  const shown = transition && (audioMode
    ? transition.type === 'audio-cross-fade'
    : transition.type !== 'audio-cross-fade')
    ? transition
    : null;
  const maxDurationFrames = Math.max(4, fps * 2);
  const activeDir = symmetric
    ? (shown?.direction === 'up' || shown?.direction === 'down' ? 'up' : 'left')
    : (shown?.direction ?? 'left');
  const activeLineColor = (shown?.lineColor ?? (shown?.type === 'clean-line-wipe' ? '#ffffff' : '#a62121')).toLowerCase();
  const activeLineWidth = shown?.lineWidthPx ?? (shown?.type === 'clean-line-wipe' ? 3.5 : 2.5);
  return (
    <div className="cc-insp-stack">
      <div className="cc-insp-muted" style={{ fontSize: audioMode ? 13 : 11.5, lineHeight: 1.45 }}>
        {audioMode
          ? t('让前一段声音渐弱、这一段声音渐强；只适用于同轨相邻音频。')
          : t('从前一个相邻片段进入本片段')}
      </div>
      <label className="cc-insp-row">
        <span className="cc-insp-label">{t('类型')}</span>
        <select className="cc-insp-select" value={shown?.type ?? ''} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (shown) onRemove(); }
          else if (shown) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">{t('无')}</option>
          {options.map((k) => <option key={k} value={k}>{t(TRANSITION_LABELS[k])}</option>)}
        </select>
      </label>
      {shown && !audioMode && <PreviewFidelityStatus status={previewStatus} />}
      {shown && (
        <>
          <SliderRow
            label={t('时长')}
            val={Number((shown.durationInFrames / fps).toFixed(2))}
            min={Number((2 / fps).toFixed(2))}
            max={Number((maxDurationFrames / fps).toFixed(2))}
            step={0.05}
            fmt={`${(shown.durationInFrames / fps).toFixed(1)}s`}
            onChange={(sec) => onSet({ durationInFrames: Math.max(2, Math.min(maxDurationFrames, Math.round(sec * fps))) })}
          />
          {needsDir && !audioMode && (
            <div className="cc-insp-row">
              <span className="cc-insp-label">{t('方向')}</span>
              <div className="cc-insp-segmented" role="group" aria-label={t('方向')}>
                {(symmetric
                  ? [['left', '横向'], ['up', '纵向']] as const
                  : [['left', '左'], ['right', '右'], ['up', '上'], ['down', '下']] as const
                ).map(([dirVal, dirLabel]) => (
                  <button
                    key={dirVal}
                    type="button"
                    aria-pressed={activeDir === dirVal}
                    onClick={() => onSet({ direction: dirVal as TransitionItem['direction'] })}
                  >
                    {t(dirLabel)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(shown.type === 'archival-line-wipe' || shown.type === 'clean-line-wipe') && !audioMode && (
            <>
              <div className="cc-insp-row">
                <span className="cc-insp-label">{t('细线颜色')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div className="cc-insp-segmented" role="group" aria-label={t('细线颜色预设')} style={{ flex: 1 }}>
                    {[
                      { label: '砖红', color: '#a62121' },
                      { label: '细金', color: '#d4af37' },
                      { label: '纯白', color: '#ffffff' },
                      { label: '徽墨', color: '#1c1816' },
                    ].map((preset) => (
                      <button
                        key={preset.color}
                        type="button"
                        aria-pressed={activeLineColor === preset.color}
                        onClick={() => onSet({ lineColor: preset.color })}
                      >
                        {t(preset.label)}
                      </button>
                    ))}
                  </div>
                  <label className="cc-insp-color-chip" style={{ paddingInline: 6 }} title={t('自定义细线颜色')}>
                    <input
                      type="color"
                      value={shown.lineColor ?? (shown.type === 'clean-line-wipe' ? '#ffffff' : '#a62121')}
                      onChange={(e) => onSet({ lineColor: e.target.value })}
                    />
                  </label>
                </div>
              </div>
              <SliderRow
                label={t('细线粗细')}
                val={activeLineWidth}
                min={1}
                max={20}
                step={0.5}
                fmt={`${activeLineWidth.toFixed(1)}px`}
                onReset={() => onSet({ lineWidthPx: shown.type === 'clean-line-wipe' ? 3.5 : 2.5 })}
                resetDisabled={Math.abs(activeLineWidth - (shown.type === 'clean-line-wipe' ? 3.5 : 2.5)) < 1e-3}
                onChange={(v) => onSet({ lineWidthPx: v })}
              />
            </>
          )}
          {shown.type === 'ink-bleed' && !audioMode && (
            <>
              <div className="cc-insp-row">
                <span className="cc-insp-label">{t('墨滴起点')}</span>
                <div className="cc-insp-segmented" role="group" aria-label={t('墨滴起点')}>
                  {[
                    { label: '中心', x: 0.5, y: 0.5 },
                    { label: '左上', x: 0.25, y: 0.28 },
                    { label: '右上', x: 0.75, y: 0.28 },
                    { label: '左下', x: 0.25, y: 0.72 },
                    { label: '右下', x: 0.75, y: 0.72 },
                  ].map((pt) => {
                    const isSelected = Math.abs((shown.originX ?? 0.5) - pt.x) < 0.03
                      && Math.abs((shown.originY ?? 0.5) - pt.y) < 0.03;
                    return (
                      <button
                        key={pt.label}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSet({ originX: pt.x, originY: pt.y })}
                      >
                        {t(pt.label)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <SliderRow
                label={t('起点横向')}
                val={Math.round((shown.originX ?? 0.5) * 100)}
                min={0}
                max={100}
                step={5}
                fmt={`${Math.round((shown.originX ?? 0.5) * 100)}%`}
                onReset={() => onSet({ originX: 0.5 })}
                resetDisabled={Math.abs((shown.originX ?? 0.5) - 0.5) < 1e-3}
                onChange={(v) => onSet({ originX: v / 100 })}
              />
              <SliderRow
                label={t('起点纵向')}
                val={Math.round((shown.originY ?? 0.5) * 100)}
                min={0}
                max={100}
                step={5}
                fmt={`${Math.round((shown.originY ?? 0.5) * 100)}%`}
                onReset={() => onSet({ originY: 0.5 })}
                resetDisabled={Math.abs((shown.originY ?? 0.5) - 0.5) < 1e-3}
                onChange={(v) => onSet({ originY: v / 100 })}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

