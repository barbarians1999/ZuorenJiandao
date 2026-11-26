import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import { HistoryGestureProvider } from './inspector/InspectorKeyframeControls';
import { InspectorContent, type InspectorTab } from './inspector/InspectorContent';
import type { InspectorPanelProps } from './inspector/InspectorTypes';
import { CaptionInspectorControls } from './inspector/CaptionInspectorControls';

function itemHasAnyKeyframes(item: TimelineItem | null | undefined): boolean {
  if (!item) return false;
  if ((item.zoom?.reframeCurve?.keyframes?.length ?? 0) > 0) return true;
  if (!item.keyframes) return false;
  for (const list of Object.values(item.keyframes)) {
    if (list && list.length > 0) return true;
  }
  return false;
}

function isFrameInRange(frame: number, range: readonly [number, number] | null): boolean {
  if (!range) return false;
  const rounded = Math.round(frame);
  return rounded >= range[0] && rounded < range[1];
}

function useInspectorPlayhead(
  getPlayhead: () => number,
  playerRef: RefObject<PlayerRef | null>,
  options: { active: boolean; hasKeyframes: boolean; itemRange: readonly [number, number] | null },
): number {
  const [playhead, setPlayhead] = useState(getPlayhead);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return undefined;
    let lastUpdate = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const apply = (frame: number) => {
      lastUpdate = performance.now();
      playheadRef.current = frame;
      setPlayhead((current) => current === frame ? current : frame);
    };
    const onFrame = (event: { detail: { frame: number } }) => {
      let playingNow = false;
      try { playingNow = Boolean(player.isPlaying?.()); } catch { playingNow = false; }
      if (!playingNow) {
        clearTimeout(trailing);
        apply(event.detail.frame);
        return;
      }
      const currentOptions = optionsRef.current;
      if (!currentOptions.active) return;
      if (!currentOptions.hasKeyframes) {
        if (isFrameInRange(playheadRef.current, currentOptions.itemRange) !== isFrameInRange(event.detail.frame, currentOptions.itemRange)) {
          apply(event.detail.frame);
        }
        return;
      }
      const wait = 180 - (performance.now() - lastUpdate);
      if (wait <= 0) {
        apply(event.detail.frame);
        return;
      }
      clearTimeout(trailing);
      trailing = setTimeout(() => apply(event.detail.frame), wait);
    };
    const onSettled = () => {
      clearTimeout(trailing);
      apply(player.getCurrentFrame());
    };
    apply(player.getCurrentFrame());
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('pause', onSettled);
    player.addEventListener('seeked', onSettled);
    return () => {
      clearTimeout(trailing);
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('pause', onSettled);
      player.removeEventListener('seeked', onSettled);
    };
  }, [playerRef]);

  useEffect(() => {
    if (!options.active) return;
    const next = playerRef.current?.getCurrentFrame?.();
    if (typeof next === 'number' && next !== playheadRef.current) {
      playheadRef.current = next;
      setPlayhead(next);
    }
  }, [options.active, options.itemRange?.[0], options.itemRange?.[1], playerRef]);

  return playhead;
}

function InspectorHeader({ panel }: { panel: InspectorPanelProps }) {
  const t = useT();
  const item = panel.selectedItem;
  const caption = panel.selectedCaption;
  const count = panel.selectedItems.length;
  return (
    <div className="cc-insp-header">
      <span className="cc-insp-heading">
        <span className="cc-insp-title">{caption ? t('字幕属性') : t('片段属性')}</span>
        {!caption && item && <span className="cc-insp-title-name" title={item.name}>{count > 1 ? t('{n} 个片段', { n: count }) : item.name}</span>}
      </span>
      {item?.denoisedSrc && <span className="cc-insp-pill">{t('人声隔离')}</span>}
    </div>
  );
}

export function InspectorPanel(panel: InspectorPanelProps) {
  const t = useT();
  const [localTab, setLocalTab] = useState<InspectorTab>('basic');
  const activeTab = panel.activeTab ?? localTab;
  const setActiveTab = panel.onActiveTabChange ?? setLocalTab;
  const item = panel.selectedItem;
  const playhead = useInspectorPlayhead(panel.getPlayhead, panel.playerRef, {
    active: !panel.collapsed && Boolean(item) && !panel.selectedCaption,
    hasKeyframes: itemHasAnyKeyframes(item),
    itemRange: item ? [item.startFrame, item.startFrame + item.durationInFrames] as const : null,
  });
  const schema = item ? panel.templates.find((template) => template.id === item.templateId)?.propSchema ?? [] : [];
  const rawLocalFrame = item ? Math.round(playhead) - item.startFrame : 0;
  const playheadLocal = {
    localFrame: item ? Math.max(0, Math.min(item.durationInFrames - 1, rawLocalFrame)) : 0,
    inRange: !!item && rawLocalFrame >= 0 && rawLocalFrame < item.durationInFrames,
  };
  return (
    <HistoryGestureProvider value={panel.historyGesture}>
      <section
        className={`cc-inspector${panel.collapsed ? ' collapsed' : ''}`}
        data-cc-shortcut-surface="inspector"
        tabIndex={-1}
        onPointerDownCapture={(event) => {
          if (!(event.target as HTMLElement).closest('button, input, select, textarea, [contenteditable="true"]')) {
            event.currentTarget.focus({ preventScroll: true });
          }
        }}
      >
        <InspectorHeader panel={panel} />
        {!panel.collapsed && (panel.selectedCaption && panel.onCaptionUpdate
          ? <CaptionInspectorControls selection={panel.selectedCaption} onUpdate={panel.onCaptionUpdate} />
          : item ? <InspectorContent panel={panel} item={item} schema={schema} playheadLocal={playheadLocal} activeTab={activeTab} onTabChange={setActiveTab} />
          : <div className="cc-insp-body"><div className="cc-insp-muted">{t('选中片段或字幕后编辑属性')}</div></div>)}
      </section>
    </HistoryGestureProvider>
  );
}
