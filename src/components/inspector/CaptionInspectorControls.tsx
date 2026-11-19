import { useEffect, useState, type CSSProperties } from 'react';
import { FontPicker } from '../../fonts/FontPicker';
import { captionFontPatch, captionSelectedFontsPatch, type CaptionFontScope } from '../../fonts/captionFontScope';
import {
  CAPTION_SCALE_MAX,
  CAPTION_SCALE_MIN,
  CAPTION_SCALE_STEP,
  captionRatioToScale,
  captionScaleToRatio,
  formatFontSizeScale,
} from '../../editor/fontSizeScale';
import {
  captionPreviewLayoutPatch,
  captionPreviewLayoutResetPatch,
  captionPreviewStylePatch,
  captionPreviewStyleResetPatch,
  captionPreviewTextPatch,
} from '../../captions/captionPreviewTarget';
import { captionPreviewTextColor, shadowBlurSize } from '../../captions/renderStyles';
import type { SelectedCaptionInspector } from '../../captions/captionSelection';
import type { CaptionAnchor, CaptionLayout, CaptionsData } from '../../captions/types';
import { useT } from '../../i18n/locale';
import { ScalarControl } from './ScalarControl';
import { useHistoryGesture } from './historyGesture';

interface CaptionInspectorControlsProps {
  selection: SelectedCaptionInspector;
  onUpdate: (patch: Partial<CaptionsData>) => void;
}

function screenY(layout: CaptionLayout | undefined): number {
  const stored = layout?.offsetYRatio ?? 0;
  return (layout?.anchor ?? 'bottom-center').startsWith('bottom') ? -stored : stored;
}

function storedY(layout: CaptionLayout | undefined, value: number): number {
  return (layout?.anchor ?? 'bottom-center').startsWith('bottom') ? -value : value;
}

function splitCaptionAnchor(anchor: CaptionAnchor | undefined): {
  v: 'top' | 'middle' | 'bottom';
  h: 'left' | 'center' | 'right';
} {
  const value = anchor ?? 'bottom-center';
  const v = value === 'top' || value.startsWith('top-')
    ? 'top'
    : value === 'center' || value.startsWith('middle-')
      ? 'middle'
      : 'bottom';
  const h = value.endsWith('-left') ? 'left' : value.endsWith('-right') ? 'right' : 'center';
  return { v, h };
}

function RangeRow({ label, value, min, max, step, display, inputScale = 1, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  inputScale?: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  const gesture = useHistoryGesture();
  const progress = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <div className="cc-insp-row cc-caption-style-row">
      <span className="cc-insp-label">{label}</span>
      <input
        className="cc-insp-range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--cc-insp-range-fill': `${progress}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
        {...gesture}
      />
      <span className="cc-insp-val">
        <ScalarControl
          ariaLabel={t('输入{name}的精确值', { name: label })}
          formatValue={display}
          inputScale={inputScale}
          max={max}
          min={min}
          onChange={onChange}
          onGestureEnd={gesture.onKeyUp}
          onGestureStart={gesture.onKeyDown}
          step={step}
          title={label}
          value={value}
        />
      </span>
    </div>
  );
}

function normalizedColor(value: string, fallback: string): string {
  const hex = /#([\da-f]{3,8})\b/i.exec(value)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    return `#${hex.slice(0, 6)}`;
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (!rgb) return fallback;
  const channel = (part: string) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0');
  return `#${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`;
}

function withShadowColor(textShadow: string, color: string): string {
  if (!textShadow || textShadow === 'none') return `0 3px 8px ${color}`;
  const matches = [...textShadow.matchAll(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/gi)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return `${textShadow}, 0 3px 8px ${color}`;
  return `${textShadow.slice(0, last.index)}${color}${textShadow.slice(last.index + last[0].length)}`;
}

function shadowColor(textShadow: string): string {
  const colors = [...textShadow.matchAll(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/gi)];
  return normalizedColor(colors.at(-1)?.[0] ?? '', '#000000');
}

function CaptionColorInput({ label, value, fallback, onChange }: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const gesture = useHistoryGesture();
  return (
    <label className="cc-insp-mg-field">
      <span>{label}</span>
      <input type="color" value={normalizedColor(value, fallback)}
        onChange={(event) => onChange(event.target.value)} {...gesture} />
    </label>
  );
}

export function CaptionInspectorControls({ selection, onUpdate }: CaptionInspectorControlsProps) {
  const t = useT();
  const { captions, target } = selection;
  const fontTargets = selection.fontTargets?.length ? selection.fontTargets : [target];
  const fontTargetIdentity = JSON.stringify(fontTargets.map((entry) => entry.key));
  const mixedFonts = fontTargets.some((entry) => entry.preset.fontFamily !== target.preset.fontFamily
    || (entry.preset.fontAssetId ?? null) !== (target.preset.fontAssetId ?? null));
  const [fontScope, setFontScope] = useState<CaptionFontScope>('selected');
  useEffect(() => setFontScope('selected'), [target.key]);
  const layout = target.layout;
  const patchLayout = (patch: CaptionLayout) => onUpdate(captionPreviewLayoutPatch(captions, target, {
    anchor: layout?.anchor ?? 'bottom-center',
    offsetXRatio: layout?.offsetXRatio ?? 0,
    offsetYRatio: layout?.offsetYRatio ?? 0,
    scale: layout?.scale ?? 1,
    rotation: layout?.rotation ?? 0,
    opacity: layout?.opacity ?? 1,
    ...patch,
  }));
  const patchStyle = (patch: Parameters<typeof captionPreviewStylePatch>[2]) =>
    onUpdate(captionPreviewStylePatch(captions, target, patch));
  const selectedEntry = target.kind === 'manual'
    ? captions.sourceEntries?.find((entry) => entry.id === target.laneId)
    : undefined;
  const styleResetDisabled = target.kind === 'single'
    ? !captions.styleOverride || Object.keys(captions.styleOverride).length === 0
    : !selectedEntry?.style || Object.keys(selectedEntry.style).length === 0;
  const transformResetDisabled = target.kind === 'single'
    ? !captions.layout
    : !selectedEntry || [selectedEntry.anchor, selectedEntry.offsetXRatio, selectedEntry.offsetYRatio,
      selectedEntry.scale, selectedEntry.rotation, selectedEntry.opacity].every((value) => value === undefined);
  const x = layout?.offsetXRatio ?? 0;
  const y = screenY(layout);
  const scale = layout?.scale ?? 1;
  const rotation = layout?.rotation ?? 0;
  const opacity = layout?.opacity ?? 1;
  const backgroundColor = target.preset.wholeLine
    ? target.preset.background ?? '#000000'
    : target.preset.highlightBackground ?? '#000000';
  const strokeOpacity = target.preset.strokeOpacity ?? 1;
  const boxBorderColor = target.preset.boxBorderColor ?? target.preset.strokeColor;
  const boxBorderWidth = target.preset.boxBorderWidth ?? 0;
  const boxBorderOpacity = target.preset.boxBorderOpacity ?? 1;
  const boxBorderRadius = target.preset.boxBorderRadius
    ?? (target.preset.background || target.preset.highlightBackground ? 6 : 0);
  const boxShadow = target.preset.boxShadow ?? 'none';
  const textShadowSize = target.preset.textShadowSize ?? shadowBlurSize(target.preset.textShadow);
  const boxShadowSize = target.preset.boxShadowSize ?? shadowBlurSize(boxShadow);
  const textColor = captionPreviewTextColor(target.preset);

  return (
    <div className="cc-insp-body">
      <div className="cc-insp-groups" data-caption-inspector="true">
      <div className="cc-insp-section">{t('文字')}</div>
      <textarea className="cc-cap-input cc-cap-textarea" value={target.cue.text}
        aria-label={t('字幕文字')}
        onChange={(event) => {
          const patch = captionPreviewTextPatch(captions, target, event.target.value);
          if (patch) onUpdate(patch);
        }} />

      <div className="cc-insp-section cc-caption-style-header">
        <span>{t('样式')}</span>
        <div className="cc-caption-font-scope cc-insp-segmented" aria-label={t('字体应用范围')}>
          <button type="button" aria-pressed={fontScope === 'selected'} onClick={() => setFontScope('selected')}>{t('选中 {n} 句', { n: fontTargets.length })}</button>
          <button type="button" aria-pressed={fontScope === 'track'} onClick={() => setFontScope('track')}>{t('整条字幕')}</button>
        </div>
        <button type="button" className="cc-insp-group-reset" disabled={styleResetDisabled}
          onClick={() => onUpdate(captionPreviewStyleResetPatch(captions, target))}>{t('重置')}</button>
      </div>
      <div className="cc-insp-mg-field"><span>{t('字体')}</span>
        <FontPicker value={fontScope === 'selected' ? target.preset.fontFamily : captions.styleOverride?.fontFamily ?? target.preset.fontFamily}
          targetKey={`${selection.trackId}:${fontTargetIdentity}:${fontScope}`}
          fontAssetId={fontScope === 'selected' ? target.preset.fontAssetId : captions.styleOverride?.fontAssetId}
          sampleText={target.cue.text}
          mixed={fontScope === 'selected' && mixedFonts}
          onChange={(choice) => onUpdate(fontScope === 'selected'
            ? captionSelectedFontsPatch(captions, choice, fontTargets)
            : captionFontPatch(captions, choice, 'track'))} />
        <span className="cc-insp-muted">{t('字体只应用到当前字幕轨道。')}</span>
      </div>
      <RangeRow label={t('字号')} value={captionRatioToScale(target.preset.fontSize)}
        min={CAPTION_SCALE_MIN} max={CAPTION_SCALE_MAX} step={CAPTION_SCALE_STEP}
        display={formatFontSizeScale(captionRatioToScale(target.preset.fontSize))}
        onChange={(scale) => patchStyle({ fontSize: captionScaleToRatio(scale) })} />
      <RangeRow label={t('字重')} value={target.preset.fontWeight} min={100} max={900} step={100}
        display={String(target.preset.fontWeight)} onChange={(value) => patchStyle({ fontWeight: value })} />
      <RangeRow label={t('文字描边')} value={target.preset.strokeWidth} min={0} max={16} step={0.5}
        display={`${Math.round(target.preset.strokeWidth * 10) / 10}px`} onChange={(value) => patchStyle({ strokeWidth: value })} />
      <RangeRow label={t('文描透明度')} value={strokeOpacity} min={0} max={1} step={0.01} inputScale={100}
        display={`${Math.round(strokeOpacity * 100)}%`} onChange={(value) => patchStyle({ strokeOpacity: value })} />
      <RangeRow label={t('文字阴影')} value={textShadowSize} min={0} max={48} step={1}
        display={`${Math.round(textShadowSize)}px`} onChange={(value) => patchStyle({ textShadowSize: value })} />
      <RangeRow label={t('边框描边')} value={boxBorderWidth} min={0} max={16} step={0.5}
        display={`${Math.round(boxBorderWidth * 10) / 10}px`} onChange={(value) => patchStyle({ boxBorderWidth: value })} />
      <RangeRow label={t('边描透明度')} value={boxBorderOpacity} min={0} max={1} step={0.01} inputScale={100}
        display={`${Math.round(boxBorderOpacity * 100)}%`} onChange={(value) => patchStyle({ boxBorderOpacity: value })} />
      <RangeRow label={t('边框圆角')} value={boxBorderRadius} min={0} max={48} step={1}
        display={`${Math.round(boxBorderRadius)}px`} onChange={(value) => patchStyle({ boxBorderRadius: value })} />
      <RangeRow label={t('边框阴影')} value={boxShadowSize} min={0} max={48} step={1}
        display={`${Math.round(boxShadowSize)}px`} onChange={(value) => patchStyle({ boxShadowSize: value })} />
      <div className="cc-insp-color-row cc-caption-color-row">
        <CaptionColorInput label={t('文字颜色')} value={textColor} fallback="#ffffff"
          onChange={(value) => patchStyle({ color: value, highlightColor: value })} />
        <CaptionColorInput label={t('文字描边')} value={target.preset.strokeColor} fallback="#000000"
          onChange={(value) => patchStyle({ strokeColor: value })} />
        <CaptionColorInput label={t('文字阴影')} value={shadowColor(target.preset.textShadow)} fallback="#000000"
          onChange={(value) => patchStyle({ textShadow: withShadowColor(target.preset.textShadow, value) })} />
      </div>
      <div className="cc-insp-color-row cc-caption-color-row">
        <CaptionColorInput label={t('边框颜色')} value={backgroundColor} fallback="#000000"
          onChange={(value) => patchStyle(target.preset.wholeLine ? { background: value } : { highlightBackground: value })} />
        <CaptionColorInput label={t('边框描边')} value={boxBorderColor} fallback="#000000"
          onChange={(value) => patchStyle({ boxBorderColor: value })} />
        <CaptionColorInput label={t('边框阴影')} value={shadowColor(boxShadow || target.preset.textShadow)} fallback="#000000"
          onChange={(value) => patchStyle({ boxShadow: withShadowColor(boxShadow, value) })} />
      </div>

      <div className="cc-insp-section">
        <span>{t('位置与变换')}</span>
        <button type="button" className="cc-insp-group-reset" disabled={transformResetDisabled}
          onClick={() => onUpdate(captionPreviewLayoutResetPatch(captions, target))}>{t('重置')}</button>
      </div>
      {(() => {
        const anchor = splitCaptionAnchor(layout?.anchor);
        return (
          <div className="cc-insp-align-bar" role="group" aria-label={t('字幕画布对齐')}>
            <div className="cc-insp-segmented">
              {(['left', 'center', 'right'] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={anchor.h === h}
                  title={h === 'left' ? t('画布左对齐') : h === 'center' ? t('画布水平居中') : t('画布右对齐')}
                  onClick={() => patchLayout({ anchor: `${anchor.v}-${h}` as CaptionAnchor, offsetXRatio: 0 })}
                >
                  {t(h === 'left' ? '左' : h === 'center' ? '中' : '右')}
                </button>
              ))}
            </div>
            <div className="cc-insp-segmented">
              {(['top', 'middle', 'bottom'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={anchor.v === v}
                  title={v === 'top' ? t('画布顶部对齐') : v === 'middle' ? t('画布垂直居中') : t('画布底部对齐')}
                  onClick={() => patchLayout({ anchor: `${v}-${anchor.h}` as CaptionAnchor, offsetYRatio: 0 })}
                >
                  {t(v === 'top' ? '顶' : v === 'middle' ? '居中' : '底')}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
      <RangeRow label={t('缩放')} value={scale} min={0.25} max={4} step={0.01} inputScale={100}
        display={`${Math.round(scale * 100)}%`} onChange={(value) => patchLayout({ scale: value })} />
      <RangeRow label={t('水平')} value={x} min={-1} max={1} step={0.01} inputScale={100}
        display={`${Math.round(x * 100)}%`} onChange={(value) => patchLayout({ offsetXRatio: value })} />
      <RangeRow label={t('垂直')} value={y} min={-1} max={1} step={0.01} inputScale={100}
        display={`${Math.round(y * 100)}%`} onChange={(value) => patchLayout({ offsetYRatio: storedY(layout, value) })} />
      <RangeRow label={t('旋转')} value={rotation} min={-180} max={180} step={1}
        display={`${Math.round(rotation)}°`} onChange={(value) => patchLayout({ rotation: value })} />
      <RangeRow label={t('透明')} value={opacity} min={0} max={1} step={0.01} inputScale={100}
        display={`${Math.round(opacity * 100)}%`} onChange={(value) => patchLayout({ opacity: value })} />
      </div>
    </div>
  );
}
