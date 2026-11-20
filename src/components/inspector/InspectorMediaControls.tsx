import { useState, type CSSProperties } from 'react';
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
import { resolveTextStyle } from '../../editor/textStyles';
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
      <div className="cc-insp-muted" style={{ fontSize: 14, marginTop: 4 }}>
        {active
          ? t('已应用降噪，源文件不变。')
          : t('适合稳定底噪，不能把配乐和人声完全分离。')}
      </div>
      {err && (
        <div style={{ fontSize: 14, color: 'var(--cc-danger, #f66)', marginTop: 4 }}>{err}</div>
      )}
    </div>
  );
}

export function SpeedControl({ item, mixed, onChange }: { item: TimelineItem; mixed?: boolean; onChange: (rate: number) => void }) {
  const t = useT();
  const rate = item.playbackRate ?? 1;
  return (
    <div>
      <SliderRow
        label={t('变速')}
        val={rate}
        mixed={mixed}
        min={0.25}
        max={4}
        step={0.05}
        fmt={`${rate.toFixed(2)}×`}
        onReset={() => onChange(1)}
        resetDisabled={!mixed && Math.abs(rate - 1) < 1e-6}
        onChange={onChange}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            className="cc-insp-btn"
            style={{
              fontSize: 10,
              padding: '2px 6px',
              opacity: Math.abs(rate - s) < 0.01 ? 1 : 0.7,
              fontWeight: Math.abs(rate - s) < 0.01 ? 700 : 400,
            }}
            onClick={() => onChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="cc-insp-muted" style={{ fontSize: 10, marginTop: 4 }}>
        {t('保调变速（预览/导出）· 时长随速率伸缩并波纹合缝')}
      </div>
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
  const selStyle: CSSProperties = {
    background: 'var(--cc-inset)',
    color: theme.text,
    border: 'none',
    borderRadius: 10,
    padding: '5px 10px',
  };
  const range = (label: string, key: string, value: number, min: number, max: number, step: number, suffix: string, fallback = 0) => (
    <SliderRow label={label} val={value} min={min} max={max} step={step} fmt={`${value}${suffix}`} mixed={mixed?.(key)}
      onReset={() => onPropChange(key, fallback)} resetDisabled={!mixed?.(key) && Math.abs(value - fallback) < 1e-6}
      onChange={(next) => onPropChange(key, next)} />
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="cc-insp-mg-field">
        <span>{t('文字内容')}</span>
        <textarea value={mixed?.('text') ? '' : style.text} placeholder={mixed?.('text') ? '—' : undefined} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          className="cc-insp-textarea"
          style={{ width: '100%', padding: '8px 10px', background: 'var(--cc-inset)', color: theme.text, border: 'none', borderRadius: 12, resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }} />
      </label>
      <div className="cc-insp-mg-field"><span>{t('字体')}</span>
        <FontPicker value={typeof p.fontFamily === 'string' ? p.fontFamily : 'sans-serif'}
          targetKey={item.id}
          fontAssetId={typeof p.fontAssetId === 'string' ? p.fontAssetId : undefined}
          sampleText={style.text} mixed={mixed?.('fontFamily') || mixed?.('fontAssetId')}
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
      <div className="cc-insp-style-pills">
        <label className="cc-insp-color-chip" title={t('文字颜色')}>
          <span>{t('颜色')}</span>
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
      {range(t('字距'), 'letterSpacing', style.letterSpacing, -10, 40, 1, 'px', 0)}
      {range(t('行距'), 'lineHeight', Number(style.lineHeight.toFixed(2)), 0.6, 3, 0.05, '', 1.2)}
      <div className="cc-insp-collapsible-group">
        <div className="cc-insp-section">{t('描边与阴影')}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="cc-insp-color-chip">{t('描边')}<input type="color" value={style.strokeColor} onChange={(e) => onPropChange('strokeColor', e.target.value)} /></label>
          <label className="cc-switch-row">
            <span>{t('启用阴影')}</span>
            <input className="cc-switch" type="checkbox" role="switch" checked={style.shadowEnabled} onChange={(e) => onPropChange('shadowEnabled', e.target.checked)} />
          </label>
        </div>
        {range(t('宽度'), 'strokeWidth', style.strokeWidth, 0, 30, 1, 'px', 0)}
        {style.shadowEnabled && <div className="cc-insp-stack">
          <label className="cc-insp-row">
            <span className="cc-insp-label">{t('阴影颜色')}</span>
            <input type="text" value={style.shadowColor} onChange={(e) => onPropChange('shadowColor', e.target.value)} style={{ gridColumn: '2 / -1', width: '100%', ...selStyle }} />
          </label>
          {range(t('模糊'), 'shadowBlur', style.shadowBlur, 0, 80, 1, 'px', 16)}
          {range(t('水平偏移'), 'shadowOffsetX', style.shadowOffsetX, -80, 80, 1, 'px', 0)}
          {range(t('垂直偏移'), 'shadowOffsetY', style.shadowOffsetY, -80, 80, 1, 'px', 3)}
        </div>}
      </div>
      <div className="cc-insp-collapsible-group">
        <div className="cc-insp-section">{t('背景框')}</div>
        <label className="cc-insp-color-chip">{t('背景色')}<input type="color" value={style.backgroundColor} onChange={(e) => onPropChange('backgroundColor', e.target.value)} /></label>
        {range(t('不透明度'), 'backgroundOpacity', style.backgroundOpacity, 0, 100, 1, '%', 0)}
        {range(t('内边距'), 'backgroundPadding', style.backgroundPadding, 0, 120, 1, 'px', 0)}
        {range(t('圆角'), 'backgroundRadius', style.backgroundRadius, 0, 120, 1, 'px', 0)}
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
  const selStyle: CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  const symmetric = transition?.type === 'blinds-reveal' || transition?.type === 'split-slide';
  const needsDir = transition && (transition.type === 'soft-wipe' || transition.type === 'whip-pan' || symmetric);
  const options = audioMode ? AUDIO_TRANSITION_ORDER : TRANSITION_ORDER;
  // When audioMode, ignore a visual transition on this clip (shouldn't exist)
  const shown = transition && (audioMode
    ? transition.type === 'audio-cross-fade'
    : transition.type !== 'audio-cross-fade')
    ? transition
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: audioMode ? 14 : 10.5, color: theme.textDim, opacity: 0.8 }}>
        {audioMode
          ? t('让前一段声音渐弱、这一段声音渐强；只适用于同轨相邻音频。')
          : t('从前一个相邻片段进入本片段')}
      </div>
      <label style={{ fontSize: audioMode ? 14 : 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('类型')}
        <select value={shown?.type ?? ''} style={selStyle} onChange={(e) => {
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
          <label style={{ fontSize: audioMode ? 14 : 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>{t('时长')} <span style={{ opacity: 0.7 }}>{(shown.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={shown.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && !audioMode && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              {t('方向')}
              <select value={symmetric ? shown.direction === 'up' || shown.direction === 'down' ? 'up' : 'left' : shown.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
                {symmetric ? <><option value="left">{t('横向')}</option><option value="up">{t('纵向')}</option></> : <><option value="left">{t('左')}</option><option value="right">{t('右')}</option><option value="up">{t('上')}</option><option value="down">{t('下')}</option></>}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}

