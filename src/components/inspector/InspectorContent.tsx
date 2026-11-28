import { useEffect, useId, type KeyboardEvent } from 'react';
import type { PropSpec } from '../../types';
import type { TimelineItem } from '../../editor/types';
import { backgroundFillStrengthOf } from '../../editor/backgroundFill';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { inspectorMixedValue } from '../../editor/inspectorBatch';
import { useT } from '../../i18n/locale';
import { hasFlexCrop, type FlexCropEdge } from '../../editor/flexCrop';
import { PropSchemaField } from './PropSchemaField';
import { TransformControl, SliderRow } from './InspectorKeyframeControls';
import { FadeControl, SpeedControl, TextControl, TransitionControl, ZoomControl } from './InspectorMediaControls';
import { BackgroundFillControl, EffectsControl, FilterControl, MaskControl, SectionLabel } from './InspectorVisualControls';
import type { InspectorPanelProps } from './InspectorTypes';
import { InspectorSlipControl } from './InspectorSlipControl';
import { groupInspectorPropSchema } from './inspectorPropSchemaLayout';
import { PictureAnimationControl } from './PictureAnimationControl';
import { InspectorAudioControls } from './InspectorAudioControls';
import { MosaicControl } from './MosaicControl';
import { CompositionMosaicControl } from './CompositionMosaicControl';
import { PreviewFidelityStatus } from './PreviewFidelityStatus';
import { hasPrivacyMosaic } from '../../editor/mosaic';
import { resolveImageStyling, type ArchivalBorderStyle, type FadeSide } from '../../editor/imageStyling';
import { PAPER_BACKGROUND_PRESETS, resolvePaperBackground, type PaperPresetId } from '../../editor/paperBackgrounds';
import { resolveVectorShape, VECTOR_SHAPE_DEFAULTS, VECTOR_SHAPE_KINDS, type VectorDashPattern, type VectorShapeKind } from '../../editor/vectorShapes';

export type InspectorTab = 'basic' | 'video' | 'audio' | 'speed' | 'animation' | 'mask' | 'effects' | 'mosaic';

interface InspectorContentProps {
  panel: InspectorPanelProps;
  item: TimelineItem;
  schema: PropSpec[];
  playheadLocal: { localFrame: number; inRange: boolean };
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
}

const TAB_DEFS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'basic', label: '画面' },
  { id: 'audio', label: '音频' },
  { id: 'speed', label: '变速' },
  { id: 'animation', label: '动画' },
  { id: 'mask', label: '蒙版' },
  { id: 'effects', label: '特效' },
  { id: 'mosaic', label: '马赛克' },
  { id: 'video', label: '调整' },
];
function nextInspectorTab(
  current: InspectorTab,
  key: string,
  available: Record<InspectorTab, boolean>,
): InspectorTab | null {
  const tabs = TAB_DEFS.filter((tab) => available[tab.id]).map((tab) => tab.id);
  const index = tabs.indexOf(current);
  if (key === 'Home') return tabs[0] ?? null;
  if (key === 'End') return tabs.at(-1) ?? null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return tabs[(index + 1) % tabs.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return tabs[(index - 1 + tabs.length) % tabs.length] ?? null;
  return null;
}
const isMixed = <T,>(panel: InspectorPanelProps, read: (item: TimelineItem) => T): boolean =>
  inspectorMixedValue(panel.selectedItems, read).mixed;


export function InspectorContent(props: InspectorContentProps) {
  const { item, panel, activeTab, onTabChange } = props;
  const tabGroupId = useId();
  const selection = panel.selectedItems.length ? panel.selectedItems : [item];
  const available: Record<InspectorTab, boolean> = {
    basic: selection.some((entry) => entry.kind !== 'audio'),
    video: selection.every((entry) => entry.kind !== 'audio' && entry.kind !== 'mosaic'),
    audio: selection.every((entry) => entry.kind === 'audio' || entry.kind === 'video'),
    animation: selection.every((entry) => entry.kind !== 'audio' && entry.kind !== 'mosaic' && entry.kind === item.kind),
    speed: !!panel.onItemSpeedChange && selection.every((entry) => ['audio', 'video', 'sequence'].includes(entry.kind)),
    mask: selection.every((entry) => entry.kind !== 'audio' && entry.kind !== 'mosaic'),
    effects: selection.every((entry) => entry.kind === 'video' || entry.kind === 'image'),
    mosaic: selection.length === 1 && selection[0]?.kind === 'mosaic' && !!panel.onCompositionMosaicChange,
  };
  const activeAvailable = available[activeTab];
  const fallback = TAB_DEFS.find((tab) => available[tab.id])?.id ?? 'basic';
  useEffect(() => {
    if (!activeAvailable) onTabChange(fallback);
  }, [activeAvailable, fallback, onTabChange]);
  const visibleTab = available[activeTab] ? activeTab : fallback;
  const basicTabLabel = selection.every((entry) => entry.kind === 'text') ? '文字' : '画面';
  return (
    <>
      <InspectorTabBar id={tabGroupId} activeTab={visibleTab} available={available} basicLabel={basicTabLabel} onChange={onTabChange} />
      <div
        id={`${tabGroupId}-panel`}
        className="cc-insp-body"
        role="tabpanel"
        aria-labelledby={`${tabGroupId}-${visibleTab}-tab`}
      >
        <div className="cc-insp-groups">
          <InspectorHint item={item} count={panel.selectedItems.length} />
          <InspectorTabContent {...props} activeTab={visibleTab} />
        </div>
      </div>
    </>
  );
}

function InspectorTabBar({ id, activeTab, available, basicLabel, onChange }: {
  id: string;
  activeTab: InspectorTab;
  available: Record<InspectorTab, boolean>;
  basicLabel: string;
  onChange: (tab: InspectorTab) => void;
}) {
  const t = useT();
  const selectFromKey = (event: KeyboardEvent, current: InspectorTab) => {
    const next = nextInspectorTab(current, event.key, available);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`${id}-${next}-tab`)?.focus());
  };
  return (
    <div className="cc-insp-tabs" role="tablist" aria-label={t('属性分类')}>
      {TAB_DEFS.filter((tab) => available[tab.id]).map((tab) => <button
        id={`${id}-${tab.id}-tab`}
        key={tab.id}
        type="button"
        role="tab"
        aria-controls={`${id}-panel`}
        aria-selected={activeTab === tab.id}
        tabIndex={activeTab === tab.id ? 0 : -1}
        disabled={!available[tab.id]}
        className={activeTab === tab.id ? 'active' : ''}
        onClick={() => onChange(tab.id)}
        onKeyDown={(event) => selectFromKey(event, tab.id)}
      >{t(tab.id === 'basic' ? basicLabel : tab.label)}</button>)}
    </div>
  );
}

function InspectorTabContent(props: InspectorContentProps) {
  if (props.activeTab === 'speed') return <SpeedTab {...props} />;
  if (props.activeTab === 'video') return <VideoTab {...props} />;
  if (props.activeTab === 'audio') return <AudioTab {...props} />;
  if (props.activeTab === 'animation') return <AnimationTab {...props} />;
  if (props.activeTab === 'mask') return <MaskTab {...props} />;
  if (props.activeTab === 'effects') return <EffectsTab {...props} />;
  if (props.activeTab === 'mosaic') return <MosaicTab {...props} />;
  return <BasicTab {...props} />;
}

function BasicTab({ panel, item, schema, playheadLocal }: InspectorContentProps) {
  const t = useT();
  const transformProps = KEYFRAME_PROPS.filter((prop) => !prop.startsWith('mask') && prop !== 'volume'
    && (item.kind !== 'mosaic' || ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity'].includes(prop))
    && getKeyframePropertyDefinition(prop).supports(item));
  const cropActive = item.kind !== 'mosaic' && panel.selectedItems.some((entry) => hasFlexCrop(entry.transform?.crop));
  const resetDisabled = !transformProps.some((prop) => {
    const definition = getKeyframePropertyDefinition(prop);
    return !!item.keyframes?.[prop]?.length || Math.abs(definition.getBaseValue(item) - definition.defaultValue) >= 1e-6;
  }) && !cropActive;
  return (
    <>
      {panel.selectedItems.length === 1 && panel.slipPlan && panel.onItemSlip && (
        <>
          <details className="cc-inspector-advanced"><summary>{t('高级：调整素材起点')}</summary>
          <InspectorSlipControl
            item={item}
            plan={panel.slipPlan}
            onSlip={panel.onItemSlip}
          />
          </details>
        </>
      )}
      {item.kind === 'text' && panel.selectedItems.every((entry) => entry.kind === 'text') && <><SectionLabel>{t('文字')}</SectionLabel><TextControl item={item} mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])} onPropChange={panel.onItemPropChange} /></>}
      {item.kind === 'motion-graphic' && panel.selectedItems.every((entry) => entry.kind === 'motion-graphic' && entry.templateId === item.templateId) && (
        <>
          <SectionLabel>{t('组件内容与样式')}</SectionLabel>
          <MotionGraphicFields item={item} schema={schema} mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])} onChange={panel.onItemPropChange} />
        </>
      )}
      {item.kind === 'solid' && panel.selectedItems.every((entry) => entry.kind === 'solid') && <SolidColorField item={item} mixed={isMixed(panel, (entry) => entry.props?.color ?? '#1a1a1a')} onChange={panel.onItemPropChange} />}
      {panel.selectedItems.every((entry) => entry.kind !== 'audio') && <><SectionLabel onReset={() => panel.onResetItemKeyframes(transformProps)} resetDisabled={resetDisabled && !transformProps.some((prop) => isMixed(panel, (entry) => getKeyframePropertyDefinition(prop).getBaseValue(entry))) && !isMixed(panel, (entry) => entry.transform?.crop)}>{t('变换')}</SectionLabel><TransformControl item={item} allowCrop={item.kind !== 'mosaic'} mixed={(prop) => {
        const definition = getKeyframePropertyDefinition(prop);
        return isMixed(panel, (entry) => entry.keyframes?.[prop] ?? definition.getBaseValue(entry));
      }} mixedCrop={(edge: FlexCropEdge) => isMixed(panel, (entry) => entry.transform?.crop?.[edge] ?? 0)} onChange={panel.onItemTransformChange} onCropChange={panel.onItemCropChange} canvasWidth={panel.canvasWidth} canvasHeight={panel.canvasHeight} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} /></>}
      {(item.kind === 'image' || item.kind === 'video') && panel.selectedItems.every((entry) => entry.kind === 'image' || entry.kind === 'video') && (
        <ImageStyleControl
          item={item}
          mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])}
          onChange={panel.onItemPropChange}
        />
      )}
    </>
  );
}

function VideoTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  const filters = item.filters;
  const resetDisabled = Math.abs((filters?.brightness ?? 1) - 1) < 1e-6
    && Math.abs((filters?.contrast ?? 1) - 1) < 1e-6
    && Math.abs((filters?.saturate ?? 1) - 1) < 1e-6
    && (filters?.blur ?? 0) === 0;
  return (
    <>
      {panel.backgroundFillAvailable && panel.onItemBackgroundFillChange && (
        <>
          <SectionLabel>{t('画布')}</SectionLabel>
          <BackgroundFillControl
            enabled={item.backgroundFill === true}
            mixed={isMixed(panel, (entry) => entry.backgroundFill === true)}
            strength={backgroundFillStrengthOf(item)}
            strengthMixed={isMixed(panel, (entry) => backgroundFillStrengthOf(entry))}
            onChange={panel.onItemBackgroundFillChange}
            onApplyToAll={panel.onApplyBackgroundFillToAll}
          />
        </>
      )}
      <SectionLabel onReset={() => panel.onItemFiltersChange({ brightness: 1, contrast: 1, saturate: 1, blur: 0 })} resetDisabled={resetDisabled && !isMixed(panel, (entry) => entry.filters)}>{t('滤镜')}</SectionLabel>
      <FilterControl item={item} mixed={{
        brightness: isMixed(panel, (entry) => entry.filters?.brightness ?? 1),
        contrast: isMixed(panel, (entry) => entry.filters?.contrast ?? 1),
        saturate: isMixed(panel, (entry) => entry.filters?.saturate ?? 1),
        blur: isMixed(panel, (entry) => entry.filters?.blur ?? 0),
      }} onChange={panel.onItemFiltersChange} autoGrade={panel.autoGrade} />
    </>
  );
}

function MaskTab({ panel, item, playheadLocal }: InspectorContentProps) {
  const t = useT();
  return <>
      {panel.selectedItems.length > 1 && <p className="cc-region-note">{t('预览画面拖动蒙版请只选中一个片段；右侧参数仍可批量调整。')}</p>}
      <SectionLabel onReset={() => panel.onItemMaskChange(null)} resetDisabled={!item.mask && !isMixed(panel, (entry) => entry.mask?.type ?? 'none')}>{t('蒙版')}</SectionLabel>
      <MaskControl item={item} mixed={{
        type: isMixed(panel, (entry) => entry.mask?.type ?? 'none'),
        x: isMixed(panel, (entry) => entry.mask?.x ?? 0),
        y: isMixed(panel, (entry) => entry.mask?.y ?? 0),
        width: isMixed(panel, (entry) => entry.mask?.width ?? 1),
        height: isMixed(panel, (entry) => entry.mask?.height ?? 1),
        feather: isMixed(panel, (entry) => entry.mask?.feather ?? 0),
      }} onChange={panel.onItemMaskChange} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} />
    </>;
}

function EffectsTab({ panel, item, playheadLocal }: InspectorContentProps) {
  const t = useT();
  if (panel.selectedItems.length !== 1) {
    return <p className="cc-region-note">{t('特效与马赛克请只选中一个视频或图片片段。')}</p>;
  }
  const effectStatus = panel.selectedPreviewStatuses?.find((status) => status.kind === 'effect' && status.targetId === item.id);
  return <>
    <SectionLabel>{t('马赛克')}</SectionLabel>
    {hasPrivacyMosaic(item) && <PreviewFidelityStatus protectedSource status={effectStatus} />}
    <MosaicControl
      item={item}
      localFrame={playheadLocal.localFrame}
      fit={panel.fit ?? 'contain'}
      canvasWidth={panel.canvasWidth}
      canvasHeight={panel.canvasHeight}
      selectedEffectId={panel.selectedMosaicEffectId ?? null}
      onSelectEffect={panel.onSelectMosaicEffect}
      onChange={panel.onItemEffectsChange}
    />
    <SectionLabel>{t('画面特效与 LUT')}</SectionLabel>
    <EffectsControl
      item={item}
      excludeMosaic
      onChange={panel.onItemEffectsChange}
      previewStatus={effectStatus}
    />
  </>;
}

function MosaicTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  if (item.kind === 'mosaic') return panel.onCompositionMosaicChange
    ? <CompositionMosaicControl value={item.mosaic} onChange={(patch) => panel.onCompositionMosaicChange?.(patch)} />
    : <p className="cc-region-note">{t('此独立马赛克当前不可编辑。')}</p>;
  return null;
}

function AudioTab({ panel, item, playheadLocal }: InspectorContentProps) {
  return <InspectorAudioControls panel={panel} item={item} playheadLocal={playheadLocal} />;
}

function AnimationTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  const visual = panel.selectedItems.every((entry) => entry.kind !== 'audio');
  return (
    <>
      {visual && panel.selectedItems.every((entry) => entry.kind === item.kind) && <><SectionLabel>{t('片段入出动画')}</SectionLabel><PictureAnimationControl key={item.id} item={item} fps={panel.fps} mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])} onChange={panel.onItemPropChange} preview={panel.animationPreview} /></>}
      {visual && (
        <>
          <SectionLabel>{t('推拉缩放')}</SectionLabel>
          <ZoomControl
            zoom={item.zoom}
            mixed={{
              shape: isMixed(panel, (entry) => entry.zoom?.shape),
              magnification: isMixed(panel, (entry) => entry.zoom?.magnification),
              focalPointX: isMixed(panel, (entry) => entry.zoom?.focalPointX),
              focalPointY: isMixed(panel, (entry) => entry.zoom?.focalPointY),
            }}
            onChange={panel.onItemZoomChange}
            getLocalFrame={() => Math.max(0, panel.getPlayhead() - item.startFrame)}
            fps={panel.fps}
            onSetKeyframe={panel.onSetReframeKeyframe}
            onRemoveKeyframe={panel.onRemoveReframeKeyframe}
          />
        </>
      )}
      {visual && panel.selectedItems.length === 1 && (
        <>
          <SectionLabel>{t('入场转场')}</SectionLabel>
          <TransitionControl
            transition={panel.transition}
            fps={panel.fps}
            onAdd={panel.onAddTransition}
            onSet={panel.onSetTransition}
            onRemove={panel.onRemoveTransition}
            previewStatus={panel.transition ? panel.selectedPreviewStatuses?.find((status) => status.kind === 'transition' && status.targetId === panel.transition!.id) : undefined}
          />
        </>
      )}
      {((item.fadeInFrames ?? 0) > 0 || (item.fadeOutFrames ?? 0) > 0) && <details className="cc-inspector-advanced"><summary>{t('已有淡入淡出')}</summary><ClipFades panel={panel} item={item} /></details>}
    </>
  );
}

function SpeedTab({ panel, item }: InspectorContentProps) {
  return panel.onItemSpeedChange ? (
    <SpeedControl
      item={item}
      fps={panel.fps}
      selectedItems={panel.selectedItems}
      mixed={isMixed(panel, (entry) => entry.playbackRate ?? 1)}
      onChange={panel.onItemSpeedChange}
      onDurationChange={panel.onItemSpeedDurationChange}
      fillToNextPlan={panel.fillToNextSpeedPlan}
      onFillToNext={panel.onItemFillToNextClip}
    />
  ) : null;
}

function ClipFades({ panel, item }: Pick<InspectorContentProps, 'panel' | 'item'>) {
  const t = useT();
  return <>
      <SectionLabel onReset={() => panel.onItemFadeChange({ fadeInFrames: 0, fadeOutFrames: 0 })} resetDisabled={(item.fadeInFrames ?? 0) === 0 && (item.fadeOutFrames ?? 0) === 0 && !isMixed(panel, (entry) => [entry.fadeInFrames ?? 0, entry.fadeOutFrames ?? 0])}>{t('淡入淡出')}</SectionLabel>
      <FadeControl item={item} mixed={{ fadeInFrames: isMixed(panel, (entry) => entry.fadeInFrames ?? 0), fadeOutFrames: isMixed(panel, (entry) => entry.fadeOutFrames ?? 0) }} fps={panel.fps} onChange={panel.onItemFadeChange} />
    </>;
}

function ImageStyleControl({ item, mixed, onChange }: {
  item: TimelineItem;
  mixed?: (key: string) => boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useT();
  const s = resolveImageStyling(item.props);
  const sideFadeVal = s.singleSideFade;
  return (
    <>
      <SectionLabel
        onReset={() => {
          onChange('bottomFade', 0);
          onChange('singleSideFade', 0);
          onChange('fadeSide', 'bottom');
          onChange('edgeFade', 0);
          onChange('dropShadow', false);
          onChange('archivalCard', false);
        }}
        resetDisabled={sideFadeVal === 0 && s.bottomFade === 0 && s.edgeFade === 0 && !s.dropShadow && !s.archivalCard}
      >
        {t('抠图融合与画报卡片')}
      </SectionLabel>
      <div className="cc-insp-stack">
        <SliderRow
          label={t('单侧渐隐')}
          val={sideFadeVal}
          min={0}
          max={80}
          step={1}
          fmt={`${sideFadeVal}%`}
          mixed={mixed?.('singleSideFade') || mixed?.('bottomFade')}
          onReset={() => { onChange('singleSideFade', 0); onChange('bottomFade', 0); }}
          resetDisabled={!mixed?.('singleSideFade') && !mixed?.('bottomFade') && sideFadeVal === 0}
          onChange={(v) => {
            onChange('singleSideFade', v);
            if (s.fadeSide === 'bottom') onChange('bottomFade', v);
          }}
        />
        {(sideFadeVal > 0 || mixed?.('fadeSide')) && (
          <div className="cc-insp-row">
            <span className="cc-insp-label">{t('渐隐方向')}</span>
            <div className="cc-insp-segmented" role="group" aria-label={t('渐隐方向')}>
              {([
                ['bottom', '底部'],
                ['top', '顶部'],
                ['left', '左侧'],
                ['right', '右侧'],
              ] as ReadonlyArray<readonly [FadeSide, string]>).map(([side, label]) => (
                <button
                  key={side}
                  type="button"
                  aria-pressed={!mixed?.('fadeSide') && s.fadeSide === side}
                  onClick={() => onChange('fadeSide', side)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        )}
        <SliderRow
          label={t('边缘柔化')}
          val={s.edgeFade}
          min={0}
          max={40}
          step={1}
          fmt={`${s.edgeFade}%`}
          mixed={mixed?.('edgeFade')}
          onReset={() => onChange('edgeFade', 0)}
          resetDisabled={!mixed?.('edgeFade') && s.edgeFade === 0}
          onChange={(v) => onChange('edgeFade', v)}
        />
        <label className="cc-switch-row">
          <span>{t('柔和立体阴影')}</span>
          <input
            className="cc-switch"
            type="checkbox"
            role="switch"
            checked={s.dropShadow}
            onChange={(e) => onChange('dropShadow', e.target.checked)}
          />
        </label>
        {s.dropShadow && (
          <>
            <SliderRow
              label={t('阴影柔化')}
              val={s.dropShadowBlur}
              min={0}
              max={80}
              step={1}
              fmt={`${s.dropShadowBlur}px`}
              onReset={() => onChange('dropShadowBlur', 26)}
              resetDisabled={s.dropShadowBlur === 26}
              onChange={(v) => onChange('dropShadowBlur', v)}
            />
            <SliderRow
              label={t('阴影浓度')}
              val={s.dropShadowOpacity}
              min={0}
              max={100}
              step={1}
              fmt={`${s.dropShadowOpacity}%`}
              onReset={() => onChange('dropShadowOpacity', 45)}
              resetDisabled={s.dropShadowOpacity === 45}
              onChange={(v) => onChange('dropShadowOpacity', v)}
            />
          </>
        )}
        <label className="cc-switch-row">
          <span>{t('一键老照片卡片')}</span>
          <input
            className="cc-switch"
            type="checkbox"
            role="switch"
            checked={s.archivalCard}
            onChange={(e) => onChange('archivalCard', e.target.checked)}
          />
        </label>
        {s.archivalCard && (
          <>
            <SliderRow
              label={t('倾斜角度')}
              val={s.archivalTilt}
              min={-12}
              max={12}
              step={0.5}
              fmt={`${s.archivalTilt}°`}
              onReset={() => onChange('archivalTilt', -2.5)}
              resetDisabled={Math.abs(s.archivalTilt - (-2.5)) < 0.01}
              onChange={(v) => onChange('archivalTilt', v)}
            />
            <SliderRow
              label={t('黑白反差')}
              val={s.archivalBw}
              min={0}
              max={100}
              step={5}
              fmt={`${s.archivalBw}%`}
              onReset={() => onChange('archivalBw', 100)}
              resetDisabled={s.archivalBw === 100}
              onChange={(v) => onChange('archivalBw', v)}
            />
            <label className="cc-insp-row">
              <span className="cc-insp-label">{t('卡片细边')}</span>
              <select
                className="cc-insp-select"
                value={s.archivalBorder}
                onChange={(e) => onChange('archivalBorder', e.target.value as ArchivalBorderStyle)}
              >
                <option value="thin-paper">{t('暖白细边')}</option>
                <option value="dark-line">{t('深墨细线')}</option>
                <option value="none">{t('无边框')}</option>
              </select>
            </label>
          </>
        )}
      </div>
    </>
  );
}

function VectorShapeControl({ item, mixed, onChange }: { item: TimelineItem; mixed?: boolean; onChange: (key: string, value: unknown) => void }) {
  const t = useT();
  const shape = resolveVectorShape(item.props)!;
  return (
    <>
      <SectionLabel>{t('基础矢量图形')}</SectionLabel>
      <div className="cc-insp-stack">
        <div className="cc-insp-row">
          <span className="cc-insp-label">{t('图形类型')}</span>
          <div className="cc-insp-segmented" role="group" aria-label={t('图形类型')}>
            {VECTOR_SHAPE_KINDS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={shape.kind === entry.id}
                onClick={() => {
                  const defaults = VECTOR_SHAPE_DEFAULTS[entry.id as VectorShapeKind];
                  onChange('shapeKind', entry.id);
                  for (const [k, v] of Object.entries(defaults)) onChange(k, v);
                }}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-insp-row">
          <span className="cc-insp-label">{t('颜色')}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="cc-insp-color-chip">
              <span>{t('线条')}{mixed ? ' —' : ''}</span>
              <input type="color" value={shape.color} onChange={(e) => onChange('color', e.target.value)} />
            </label>
            {shape.kind === 'rect' && (
              <label className="cc-insp-color-chip">
                <span>{t('填充')}</span>
                <input type="color" value={shape.fillColor} onChange={(e) => onChange('fillColor', e.target.value)} />
              </label>
            )}
          </div>
        </div>
        <SliderRow
          label={t('线条粗细')}
          val={shape.strokeWidth}
          min={1}
          max={20}
          step={0.5}
          fmt={`${shape.strokeWidth}px`}
          onReset={() => onChange('strokeWidth', shape.kind === 'line' ? 2 : 3)}
          resetDisabled={Math.abs(shape.strokeWidth - (shape.kind === 'line' ? 2 : 3)) < 1e-6}
          onChange={(v) => onChange('strokeWidth', v)}
        />
        <label className="cc-insp-row">
          <span className="cc-insp-label">{t('线型')}</span>
          <select
            className="cc-insp-select"
            value={shape.dashPattern}
            onChange={(e) => onChange('dashPattern', e.target.value as VectorDashPattern)}
          >
            <option value="solid">{t('实线')}</option>
            <option value="dashed">{t('虚线')}</option>
            <option value="dotted">{t('点线')}</option>
          </select>
        </label>
        <SliderRow
          label={t('不透明度')}
          val={shape.opacity}
          min={0}
          max={100}
          step={1}
          fmt={`${shape.opacity}%`}
          onReset={() => onChange('opacity', 100)}
          resetDisabled={shape.opacity === 100}
          onChange={(v) => onChange('opacity', v)}
        />
        {shape.kind === 'rect' ? (
          <>
            <SliderRow label={t('圆角')} val={shape.cornerRadius} min={0} max={80} step={1} fmt={`${shape.cornerRadius}px`} onReset={() => onChange('cornerRadius', 4)} resetDisabled={shape.cornerRadius === 4} onChange={(v) => onChange('cornerRadius', v)} />
            <SliderRow label={t('填充不透明')} val={shape.fillOpacity} min={0} max={100} step={1} fmt={`${shape.fillOpacity}%`} onReset={() => onChange('fillOpacity', 0)} resetDisabled={shape.fillOpacity === 0} onChange={(v) => onChange('fillOpacity', v)} />
            <SliderRow label={t('框宽度')} val={Math.round(shape.width * 100)} min={2} max={100} step={1} fmt={`${Math.round(shape.width * 100)}%`} onReset={() => onChange('width', 0.5)} resetDisabled={Math.abs(shape.width - 0.5) < 1e-3} onChange={(v) => onChange('width', v / 100)} />
            <SliderRow label={t('框高度')} val={Math.round(shape.height * 100)} min={2} max={100} step={1} fmt={`${Math.round(shape.height * 100)}%`} onReset={() => onChange('height', 0.5)} resetDisabled={Math.abs(shape.height - 0.5) < 1e-3} onChange={(v) => onChange('height', v / 100)} />
          </>
        ) : (
          <>
            <SliderRow label={t('起点 X')} val={Math.round(shape.x1 * 100)} min={0} max={100} step={1} fmt={`${Math.round(shape.x1 * 100)}%`} onReset={() => onChange('x1', 0.25)} resetDisabled={Math.abs(shape.x1 - 0.25) < 1e-3} onChange={(v) => onChange('x1', v / 100)} />
            <SliderRow label={t('起点 Y')} val={Math.round(shape.y1 * 100)} min={0} max={100} step={1} fmt={`${Math.round(shape.y1 * 100)}%`} onReset={() => onChange('y1', 0.5)} resetDisabled={Math.abs(shape.y1 - 0.5) < 1e-3} onChange={(v) => onChange('y1', v / 100)} />
            <SliderRow label={t('终点 X')} val={Math.round(shape.x2 * 100)} min={0} max={100} step={1} fmt={`${Math.round(shape.x2 * 100)}%`} onReset={() => onChange('x2', 0.75)} resetDisabled={Math.abs(shape.x2 - 0.75) < 1e-3} onChange={(v) => onChange('x2', v / 100)} />
            <SliderRow label={t('终点 Y')} val={Math.round(shape.y2 * 100)} min={0} max={100} step={1} fmt={`${Math.round(shape.y2 * 100)}%`} onReset={() => onChange('y2', 0.5)} resetDisabled={Math.abs(shape.y2 - 0.5) < 1e-3} onChange={(v) => onChange('y2', v / 100)} />
            {shape.kind === 'arrow' && (
              <>
                <SliderRow label={t('箭头大小')} val={shape.arrowHeadSize} min={6} max={48} step={1} fmt={`${shape.arrowHeadSize}px`} onReset={() => onChange('arrowHeadSize', 16)} resetDisabled={shape.arrowHeadSize === 16} onChange={(v) => onChange('arrowHeadSize', v)} />
                <label className="cc-switch-row">
                  <span>{t('双向箭头')}</span>
                  <input className="cc-switch" type="checkbox" role="switch" checked={shape.bidirectional} onChange={(e) => onChange('bidirectional', e.target.checked)} />
                </label>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function SolidColorField({ item, mixed, onChange }: { item: TimelineItem; mixed?: boolean; onChange: (key: string, value: unknown) => void }) {
  const t = useT();
  if (resolveVectorShape(item.props)) {
    return <VectorShapeControl item={item} mixed={mixed} onChange={onChange} />;
  }
  const paper = resolvePaperBackground(item.props);
  return (
    <>
      <SectionLabel>{t('纯色与纸纹背景板')}</SectionLabel>
      <div className="cc-insp-stack">
        <label className="cc-insp-row">
          <span className="cc-insp-label">{t('背景样式')}</span>
          <select
            className="cc-insp-select"
            value={paper.presetId}
            onChange={(event) => {
              const nextPreset = event.target.value as PaperPresetId;
              onChange('paperPreset', nextPreset);
              if (nextPreset === 'custom') {
                onChange('paperCenterColor', paper.colors[0]);
                onChange('paperMidColor', paper.colors[1]);
                onChange('paperEdgeColor', paper.colors[2]);
                onChange('paperLineColor', paper.lineColor);
                return;
              }
              const found = PAPER_BACKGROUND_PRESETS.find((preset) => preset.id === nextPreset);
              if (found) {
                onChange('color', found.colors[1]);
                onChange('paperGrain', found.defaultGrain);
                onChange('paperVignette', found.defaultVignette);
                onChange('paperAccentLine', found.defaultAccentLine);
              }
            }}
          >
            <option value="none">{t('普通纯色')}</option>
            {PAPER_BACKGROUND_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{t(preset.label)}</option>
            ))}
            <option value="custom">{t('自定义径向纸纹')}</option>
          </select>
        </label>
        {paper.presetId === 'none' ? (
          <div className="cc-insp-row">
            <span className="cc-insp-label">{t('填充颜色')}</span>
            <div>
              <label className="cc-insp-color-chip">
                <span>{String(item.props?.color ?? '#1a1a1a')}{mixed ? ' —' : ''}</span>
                <input type="color" value={String(item.props?.color ?? '#1a1a1a')} onChange={(event) => onChange('color', event.target.value)} />
              </label>
            </div>
          </div>
        ) : (
          <>
            {paper.presetId === 'custom' && (
              <div className="cc-insp-color-grid">
                <label className="cc-insp-color-chip"><span>{t('中心色')}</span><input type="color" value={paper.colors[0]} onChange={(e) => onChange('paperCenterColor', e.target.value)} /></label>
                <label className="cc-insp-color-chip"><span>{t('过渡色')}</span><input type="color" value={paper.colors[1]} onChange={(e) => { onChange('paperMidColor', e.target.value); onChange('color', e.target.value); }} /></label>
                <label className="cc-insp-color-chip"><span>{t('边缘色')}</span><input type="color" value={paper.colors[2]} onChange={(e) => onChange('paperEdgeColor', e.target.value)} /></label>
                <label className="cc-insp-color-chip"><span>{t('细线色')}</span><input type="color" value={paper.lineColor} onChange={(e) => onChange('paperLineColor', e.target.value)} /></label>
              </div>
            )}
            <SliderRow
              label={t('纸纹颗粒')}
              val={paper.paperGrain}
              min={0}
              max={100}
              step={1}
              fmt={`${paper.paperGrain}%`}
              onReset={() => onChange('paperGrain', paper.preset?.defaultGrain ?? 20)}
              resetDisabled={paper.paperGrain === (paper.preset?.defaultGrain ?? 20)}
              onChange={(v) => onChange('paperGrain', v)}
            />
            <SliderRow
              label={t('四周暗角')}
              val={paper.paperVignette}
              min={0}
              max={100}
              step={1}
              fmt={`${paper.paperVignette}%`}
              onReset={() => onChange('paperVignette', paper.preset?.defaultVignette ?? 30)}
              resetDisabled={paper.paperVignette === (paper.preset?.defaultVignette ?? 30)}
              onChange={(v) => onChange('paperVignette', v)}
            />
            <label className="cc-switch-row">
              <span>{t('画报细线装饰')}</span>
              <input
                className="cc-switch"
                type="checkbox"
                role="switch"
                checked={paper.paperAccentLine}
                onChange={(e) => onChange('paperAccentLine', e.target.checked)}
              />
            </label>
          </>
        )}
      </div>
    </>
  );
}

const ADVANCED_MG_PROP_KEYS = new Set([
  'endX',
  'endY',
  'scanStartFrame',
  'lockStartFrame',
  'lockEndFrame',
  'stepFrames',
  'highlightSteps',
  'decimals',
  'rollStartFrame',
  'rollEndFrame',
  'lineFrames',
  'highlightLines',
  'strikeLines',
  'strikeStartFrame',
  'strikeDurationFrames',
  'highlightIndex',
  'itemFrames',
  'maxValue',
  'showValueRoll',
  'drawStartFrame',
  'drawEndFrame',
  'highlightFrames',
  'yMin',
  'yMax',
  'showNodeValues',
  'sweepStartFrame',
  'sweepEndFrame',
  'compareStartFrame',
  'compareEndFrame',
  'dualAnimStyle',
  'fontFamily',
]);

function isAdvancedMotionGraphicProp(field: PropSpec): boolean {
  if (ADVANCED_MG_PROP_KEYS.has(field.key)) return true;
  const label = field.label ?? '';
  return label.startsWith('踩点：');
}

function renderMotionGraphicGroupList(
  fields: readonly PropSpec[],
  item: TimelineItem,
  mixed: ((key: string) => boolean) | undefined,
  onChange: (key: string, value: unknown) => void,
) {
  return groupInspectorPropSchema(fields).map((group, groupIndex) => group.kind === 'color-row'
    ? <div className="cc-insp-color-row" key={`color-row:${groupIndex}`}>
      {group.fields.map((field) => <PropSchemaField
        key={field.key}
        spec={field}
        mixed={mixed?.(field.key)}
        value={item.props?.[field.key]}
        onChange={(value) => onChange(field.key, value)}
      />)}
    </div>
    : group.fields.map((field) => <PropSchemaField
      key={field.key}
      spec={field}
      mixed={mixed?.(field.key)}
      value={item.props?.[field.key]}
      onChange={(value) => onChange(field.key, value)}
    />));
}

function MotionGraphicFields({ item, schema, mixed, onChange }: {
  item: TimelineItem;
  schema: PropSpec[];
  mixed?: (key: string) => boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useT();
  if (schema.length === 0) return <div className="cc-insp-muted">{t('该模板无可编辑属性。')}</div>;
  const primaryFields = schema.filter((field) => !isAdvancedMotionGraphicProp(field));
  const advancedFields = schema.filter(isAdvancedMotionGraphicProp);
  const hasActiveAdvancedValue = advancedFields.some((field) => {
    const val = item.props?.[field.key];
    return val !== undefined && val !== '' && val !== field.defaultValue;
  });
  return (
    <div className="cc-insp-mg-grid">
      {renderMotionGraphicGroupList(primaryFields.length > 0 ? primaryFields : schema, item, mixed, onChange)}
      {primaryFields.length > 0 && advancedFields.length > 0 && (
        <details className="cc-inspector-advanced" open={hasActiveAdvancedValue || undefined}>
          <summary>{t('高级：帧级踩点与微调参数')}</summary>
          <div className="cc-insp-mg-grid">
            {renderMotionGraphicGroupList(advancedFields, item, mixed, onChange)}
          </div>
        </details>
      )}
    </div>
  );
}

function InspectorHint({ item, count }: { item: TimelineItem; count: number }) {
  const t = useT();
  // Single selection already shows the clip type in the inspector header above the tabs.
  if (count <= 1) return null;
  const labels: Partial<Record<TimelineItem['kind'], string>> = {
    audio: '音频',
    video: '视频',
    image: '图片',
    gif: 'GIF',
    svg: 'SVG',
    solid: '纯色',
    text: '文字',
    'motion-graphic': '动效图形',
    sequence: t('嵌套序列'),
    mosaic: '马赛克',
  };
  return (
    <div className="cc-insp-scope">
      <strong>{t('已选择 {n} 个片段', { n: count })}</strong>
      <span className="cc-insp-scope-kind">{t(labels[item.kind] ?? '片段')}</span>
    </div>
  );
}
