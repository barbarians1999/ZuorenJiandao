import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AbsoluteFill, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ALL_FX, registerCustomFx } from '../gl/fx/effects';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
import { previewTextEditFields } from '../components/preview/previewTextEdit';
import type { AspectFit, ProjectDoc, Timeline, TimelineItem, TimelineState } from './types';
import { sourceFrameAt } from './sourceLimit';
import { nestedSequenceFrom, resolveTimelineRenderPlan, SequenceGraphError, type SequenceGraphLimits } from './sequenceGraph';
import { PreviewTransitionIn } from './transitionPreview.tsx';
import { TimelineReadinessGate } from './TimelineReadinessGate';
import { timelineReadinessKey } from './timelineReadinessKey';
import { isBackgroundFillActive } from './backgroundFill';
import { ClipWrapper } from './TimelineClipWrapper';
import { GlTransitionVisibility } from './GlTransitionVisibility';
import { updateReadyGlWindows } from './glTransitionVisibilityState';
import { AudioClip, PlayerAudioLayers, BackgroundFillLayer, ContinuousVideoAudio, MediaFill, SharedVideoVisualGroup, VisualClipSurface } from './TimelineMediaLayer';
import { compositionPlan } from './compositionPlan';
import { compositionBackground } from './compositionBackground';
import { hasPrivacyMosaic } from './mosaic';
import { ItemLayer, SolidLayer, TextLayer, WatermarkLayer } from './TimelineGraphicLayers';
import { TimelineMosaicBarrier } from './CompositionMosaicSurface';

function NestedSequenceLayer({ item, project, parentWidth, parentHeight, fit, frameOffset, browserRenderer, sequenceLimits, muted }: {
  item: TimelineItem;
  project?: ProjectDoc;
  parentWidth: number;
  parentHeight: number;
  fit: AspectFit;
  frameOffset: number;
  browserRenderer: boolean;
  sequenceLimits?: SequenceGraphLimits;
  muted: boolean;
}) {
  const parentFrame = useCurrentFrame();
  const localFrame = parentFrame + frameOffset;
  const resolved = useMemo(() => {
    if (!project || !item.timelineId) return null;
    const child = project.timelines.find((timeline) => timeline.id === item.timelineId);
    return child ? {
      child,
      durationInFrames: resolveTimelineRenderPlan(project, child.id, sequenceLimits).durationInFrames,
    } : null;
  }, [item.timelineId, project, sequenceLimits]);
  if (!resolved) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      itemId: item.id,
      referencedTimelineId: item.timelineId,
      path: [item.timelineId ?? ''],
    });
  }
  const { child, durationInFrames: childDuration } = resolved;
  const sourceFrame = Math.min(childDuration - 1, sourceFrameAt(item, localFrame));
  const dynamicFrom = nestedSequenceFrom(parentFrame, sourceFrame);
  const scale = fit === 'cover'
    ? Math.max(parentWidth / child.width, parentHeight / child.height)
    : Math.min(parentWidth / child.width, parentHeight / child.height);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: child.width, height: child.height, position: 'relative', flexShrink: 0, transform: `scale(${scale})` }}>
        <Sequence from={dynamicFrom} durationInFrames={childDuration} layout="none">
          <TimelineContent
            state={child}
            project={project}
            timelineId={child.id}
            transparent
            browserRenderer={browserRenderer}
            sequenceLimits={sequenceLimits}
            forceMuted={muted}
          />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
}


// Renders the ENTIRE timeline. Visual tracks composite bottom-up: V1 then V2 on
// top. Audio items (A1/A2) play via <Audio> and produce no picture.
export type TimelineCompositionProps = Record<string, unknown> & {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
  sequenceLimits?: SequenceGraphLimits;
  /** Mute all descendant audio when a containing sequence track is muted. */
  forceMuted?: boolean;
  transparent?: boolean;
  /** Use @remotion/media so @remotion/web-renderer can decode media via WebCodecs. */
  browserRenderer?: boolean;
  /** The selected clip is the Player's explicit full-fidelity GL preview target. */
  selectedItemId?: string | null;
  hiddenCaptionKeys?: Record<string, string | null>;
  onSelectedPreviewStatus?: SelectedPreviewStatusListener;
};

function SelectedPreviewStatusReporter({ status, listener }: {
  status: SelectedPreviewStatus;
  listener?: SelectedPreviewStatusListener;
}) {
  useEffect(() => {
    if (!listener) return undefined;
    const snapshot = {
      kind: status.kind,
      targetId: status.targetId,
      adapter: status.adapter,
      phase: status.phase,
      fallbackReason: status.fallbackReason,
    };
    listener(snapshot);
    return () => listener({ ...snapshot, phase: 'inactive' });
  }, [listener, status.kind, status.targetId, status.adapter, status.phase, status.fallbackReason]);
  return null;
}

interface PlayerPictureLayersProps {
  pictureLayers: ReturnType<typeof compositionPlan>['pictureLayers'];
  renderVisualLayer: (group: TimelineItem[]) => ReactNode;
  renderTransition: (w: ReturnType<typeof compositionPlan>['glWindows'][number]) => ReactNode;
  state: TimelineState;
  extendBefore: Map<string, number>;
  extendAfter: Map<string, number>;
  premountFrames: number;
  selectedItemId?: string | null;
  hiddenCaptionKeys?: Record<string, string | null>;
}

function PlayerPictureLayers({
  pictureLayers,
  renderVisualLayer,
  renderTransition,
  state,
  extendBefore,
  extendAfter,
  premountFrames,
  selectedItemId,
  hiddenCaptionKeys,
}: PlayerPictureLayersProps) {
  const currentFrame = useCurrentFrame();

  const { activeVisualIds, activeTransitionKeys } = useMemo(() => {
    const activeVisual = new Set<string>();
    const activeTransitions = new Set<string>();

    interface VisualCandidate {
      id: string;
      from: number;
      to: number;
    }

    const currentVisuals: VisualCandidate[] = [];
    const upcomingVisuals: VisualCandidate[] = [];
    const recentVisuals: VisualCandidate[] = [];

    for (const layer of pictureLayers) {
      if (layer.kind === 'visual') {
        const items = layer.items;
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) continue;

        const eb = extendBefore.get(first.id) ?? 0;
        const ea = extendAfter.get(last.id) ?? 0;
        const from = first.startFrame - eb;
        const to = last.startFrame + last.durationInFrames + ea;
        const id = first.id;

        const isSelected = selectedItemId ? items.some((it) => it.id === selectedItemId) : false;
        if (isSelected) {
          activeVisual.add(id);
          continue;
        }

        if (currentFrame >= from && currentFrame < to) {
          currentVisuals.push({ id, from, to });
        } else if (from > currentFrame && from <= currentFrame + premountFrames) {
          upcomingVisuals.push({ id, from, to });
        } else if (to <= currentFrame && currentFrame < to + 5) {
          recentVisuals.push({ id, from, to });
        }
      } else if (layer.kind === 'transition') {
        const w = layer.window;
        const isSelected = selectedItemId
          ? (w.incoming.id === selectedItemId || w.outgoing.id === selectedItemId)
          : false;
        const isCurrent = currentFrame >= w.from && currentFrame < w.from + w.L;
        const isUpcoming = w.from > currentFrame && w.from <= currentFrame + premountFrames;
        const isRecent = (w.from + w.L) <= currentFrame && currentFrame < (w.from + w.L + 5);

        if (isSelected || isCurrent || isUpcoming || isRecent) {
          activeTransitions.add(w.key);
        }
      }
    }

    for (const v of currentVisuals) {
      activeVisual.add(v.id);
    }

    upcomingVisuals.sort((a, b) => a.from - b.from);
    for (let i = 0; i < Math.min(2, upcomingVisuals.length); i++) {
      activeVisual.add(upcomingVisuals[i]!.id);
    }

    recentVisuals.sort((a, b) => b.to - a.to);
    if (recentVisuals.length > 0) {
      activeVisual.add(recentVisuals[0]!.id);
    }

    return { activeVisualIds: activeVisual, activeTransitionKeys: activeTransitions };
  }, [pictureLayers, currentFrame, premountFrames, selectedItemId, extendBefore, extendAfter]);

  let picture: ReactNode[] = [];
  for (const layer of pictureLayers) {
    if (layer.kind === 'mosaic') {
      picture = [
        <TimelineMosaicBarrier
          key={`mosaic:${layer.item.id}`}
          item={layer.item}
          width={state.width}
          height={state.height}
          unsupportedTransition={state.transitions?.some(
            (transition) =>
              transition.enabled !== false &&
              (transition.incomingItemId === layer.item.id ||
                transition.outgoingItemId === layer.item.id)
          )}
        >
          {picture}
        </TimelineMosaicBarrier>,
      ];
    } else if (layer.kind === 'visual') {
      const first = layer.items[0];
      if (first && activeVisualIds.has(first.id)) {
        picture.push(renderVisualLayer(layer.items));
      }
    } else if (layer.kind === 'transition') {
      if (activeTransitionKeys.has(layer.window.key)) {
        picture.push(renderTransition(layer.window));
      }
    } else if (layer.entry.captions?.enabled) {
      picture.push(
        <CaptionsLayer
          key={layer.entry.id}
          captions={layer.entry.captions}
          items={state.items}
          hiddenKey={hiddenCaptionKeys?.[layer.entry.id]}
        />
      );
    }
  }

  return <>{picture}</>;
}

function TimelineContent({ state, project, transparent, browserRenderer = false, selectedItemId, hiddenCaptionKeys, onSelectedPreviewStatus, sequenceLimits, forceMuted = false }: TimelineCompositionProps) {
  const [readyGlWindows, setReadyGlWindows] = useState<Set<string>>(() => new Set());
  const setGlWindowReady = useCallback((key: string, ready: boolean) => {
    setReadyGlWindows((current) => updateReadyGlWindows(current, key, ready));
  }, []);
  // Non-built-in fx (plugin/submit_shader)def is self-contained with state: synchronously registered into ALL_FX before rendering,
  // The first frame of the subcomponent (MediaFill's firstGlEffect route) is parsed - a fresh browser with headless export
  // There is no memory registry, it all depends on this. Idempotism is guarded; rendering external registries is the only deliberate exception here.
  if (state.fxDefs) {
    for (const def of Object.values(state.fxDefs)) if (!(def.id in ALL_FX)) registerCustomFx(def);
  }
  const environment = getRemotionEnvironment();
  const premountFrames = environment.isRendering ? 0 : Math.round(state.fps);
  const plan = useMemo(() => compositionPlan(state, {
    mode: environment.isPlayer ? 'player' : 'render',
    selectedItemId, forceMuted, registeredEffects: ALL_FX,
  }), [state, environment.isPlayer, selectedItemId, forceMuted]);
  const {
    audio, captionEntries, fit, isMuted, gainAt,
    videoAudioGroups, groupedVideoIds, entranceOf, extendBefore, extendAfter,
    glWindows, glVisibilityWindows, staticPreviewStatuses, selectedEffectStaticStatus,
    pictureLayers,
  } = plan;

  const renderVisualLayer = (group: TimelineItem[]) => {
        const item = group[0]!;
        if (group.length > 1) return <SharedVideoVisualGroup
          key={`sv:${item.id}`} group={group} fit={fit} muted={isMuted(item.track)}
          canvasW={state.width} canvasH={state.height} premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />;
        const eb = extendBefore.get(item.id) ?? 0;
        const ea = extendAfter.get(item.id) ?? 0;
        const entrance = entranceOf.get(item.id);
        // Captions off hides on-screen text clips too (render-layer only).
        const captionsOff = state.captionsHidden === true
          || (state.captionsHidden === undefined && captionEntries.length > 0 && captionEntries.every((entry) => !entry.captions?.enabled));
        const hiddenByCaptions = captionsOff && previewTextEditFields(item) !== null;
        const fillBackground = isBackgroundFillActive(state, item);
        const foreground = (
          <ClipWrapper item={item} frameOffset={-eb} hiddenByCaptions={hiddenByCaptions}>
            {(borderRadius) => item.kind === 'sequence'
              ? <VisualClipSurface item={item} fit={fit} canvasW={state.width} canvasH={state.height} borderRadius={borderRadius}>
                  <NestedSequenceLayer item={item} project={project} parentWidth={state.width} parentHeight={state.height} fit={fit} frameOffset={-eb} browserRenderer={browserRenderer} sequenceLimits={sequenceLimits} muted={isMuted(item.track)} />
                </VisualClipSurface>
              : item.kind === 'motion-graphic'
              ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} borderRadius={borderRadius} frameOffset={-eb} />
              : item.kind === 'text'
              ? <TextLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} frameOffset={-eb} />
              : item.kind === 'solid'
              ? <SolidLayer item={item} canvasW={state.width} canvasH={state.height} borderRadius={borderRadius} />
              : <MediaFill item={item} frameOffset={-eb} fit={fillBackground ? 'contain' : fit}
                  muted={isMuted(item.track)} groupedAudio={groupedVideoIds.has(item.id)}
                  gainAt={(frame) => gainAt(item.track, frame)} canvasW={state.width} canvasH={state.height}
                  borderRadius={borderRadius} browserRenderer={browserRenderer}
                  exactEffects={!environment.isPlayer || item.id === selectedItemId || hasPrivacyMosaic(item)}
                  onPreviewStatus={environment.isPlayer && item.id === selectedItemId && !selectedEffectStaticStatus
                    ? onSelectedPreviewStatus : undefined} />}
          </ClipWrapper>
        );
        const content = (
          <>
            {fillBackground && <BackgroundFillLayer item={item} frameOffset={-eb} canvasW={state.width}
              canvasH={state.height} browserRenderer={browserRenderer}
              exactEffects={!environment.isPlayer || item.id === selectedItemId || hasPrivacyMosaic(item)} />}
            {foreground}
          </>
        );
        return (
          <Sequence
            key={item.id}
            from={item.startFrame - eb}
            durationInFrames={item.durationInFrames + eb + ea}
            premountFor={premountFrames}
            postmountFor={environment.isPlayer ? 5 : 0}
            styleWhilePremounted={environment.isPlayer ? { opacity: 0 } : undefined}
            styleWhilePostmounted={environment.isPlayer ? { opacity: 0, pointerEvents: 'none' } : undefined}
            name={item.name}
          >
            <GlTransitionVisibility itemId={item.id} sequenceFrom={item.startFrame - eb}
              windows={glVisibilityWindows} readyWindows={readyGlWindows}>
              {entrance
                ? <PreviewTransitionIn type={entrance.type} frames={entrance.frames} dir={entrance.dir} line={entrance.line} isolated={entrance.isolated}>{content}</PreviewTransitionIn>
                : content}
            </GlTransitionVisibility>
          </Sequence>
        );
  };
  const renderTransition = (w: typeof glWindows[number]) => (
        <Sequence
          key={w.key}
          from={w.from}
          durationInFrames={w.L}
          premountFor={premountFrames}
          postmountFor={environment.isPlayer ? 5 : 0}
          styleWhilePremounted={environment.isPlayer ? { opacity: 0 } : undefined}
          styleWhilePostmounted={environment.isPlayer ? { opacity: 0, pointerEvents: 'none' } : undefined}
          name={`tr:${w.type}`}
        >
          <GlTransition
            type={w.type} direction={w.direction} L={w.L} windowStart={w.from}
            outgoing={w.outgoing} incoming={w.incoming} trimOut={w.trimOut} trimIn={w.trimIn}
            width={state.width} height={state.height} fit={fit}
            outgoingBackgroundFill={isBackgroundFillActive(state, w.outgoing)}
            incomingBackgroundFill={isBackgroundFillActive(state, w.incoming)}
            customFrag={w.customFrag} customUniforms={w.customUniforms}
            previewTargetId={w.previewTargetId} onPreviewStatus={w.previewTargetId ? onSelectedPreviewStatus : undefined}
            onReadyChange={(ready) => setGlWindowReady(w.key, ready)}
          />
        </Sequence>
  );
  let picture: ReactNode[] = [];
  if (!environment.isPlayer) {
    for (const layer of pictureLayers) {
      if (layer.kind === 'mosaic') {
        picture = [<TimelineMosaicBarrier key={`mosaic:${layer.item.id}`} item={layer.item} width={state.width} height={state.height}
          unsupportedTransition={state.transitions?.some(transition => transition.enabled !== false
            && (transition.incomingItemId === layer.item.id || transition.outgoingItemId === layer.item.id))}>
          {picture}
        </TimelineMosaicBarrier>];
      } else if (layer.kind === 'visual') picture.push(renderVisualLayer(layer.items));
      else if (layer.kind === 'transition') picture.push(renderTransition(layer.window));
      else if (layer.entry.captions?.enabled) picture.push(
        <CaptionsLayer key={layer.entry.id} captions={layer.entry.captions} items={state.items} hiddenKey={hiddenCaptionKeys?.[layer.entry.id]} />,
      );
    }
  }

  return (
    <AbsoluteFill style={{ background: compositionBackground(!!transparent, environment.isRendering || browserRenderer) }}>
      {staticPreviewStatuses.map((status) => (
        <SelectedPreviewStatusReporter
          key={`${status.kind}:${status.targetId}`}
          status={status}
          listener={onSelectedPreviewStatus}
        />
      ))}
      {environment.isPlayer ? (
        <PlayerPictureLayers
          pictureLayers={pictureLayers}
          renderVisualLayer={renderVisualLayer}
          renderTransition={renderTransition}
          state={state}
          extendBefore={extendBefore}
          extendAfter={extendAfter}
          premountFrames={premountFrames}
          selectedItemId={selectedItemId}
          hiddenCaptionKeys={hiddenCaptionKeys}
        />
      ) : (
        picture
      )}
      {environment.isPlayer ? <PlayerAudioLayers items={audio} timelineItems={state.items} assets={project?.assets ?? state.assets}
        transitions={state.transitions} fps={state.fps} premountFor={premountFrames} browserRenderer={browserRenderer}
        isMuted={isMuted} gainAt={gainAt} /> : audio.map((item) => (
        <AudioClip
          key={item.id}
          item={item}
          fps={state.fps}
          muted={isMuted(item.track)}
          gainAt={(frame) => gainAt(item.track, frame)}
          timelineItems={state.items}
          assets={project?.assets ?? state.assets}
          transitions={state.transitions}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      ))}
      {videoAudioGroups.map((group) => (
        <ContinuousVideoAudio
          key={`audio:${group[0]!.id}`}
          items={group}
          muted={isMuted(group[0]!.track)}
          gainAt={gainAt}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      ))}
      {state.watermark?.enabled && state.watermark.text
        && <WatermarkLayer watermark={state.watermark} canvasH={state.height} />}
    </AbsoluteFill>
  );
}

export function TimelineComposition(props: TimelineCompositionProps) {
  const stateTimelineId = 'id' in props.state && typeof props.state.id === 'string' ? props.state.id : undefined;
  const timelineId = props.timelineId ?? stateTimelineId ?? props.project?.activeTimelineId;
  if (props.state.items.some((item) => item.kind === 'sequence') && (!props.project || !timelineId)) {
    const item = props.state.items.find((candidate) => candidate.kind === 'sequence')!;
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      itemId: item.id,
      referencedTimelineId: item.timelineId,
      path: [item.timelineId ?? ''],
    });
  }
  const plan = props.project && timelineId
    ? resolveTimelineRenderPlan(props.project, timelineId, props.sequenceLimits)
    : null;
  const dependencies = plan
    ? plan.timelineIds
        .filter((id) => id !== timelineId)
        .map((id) => props.project!.timelines.find((timeline) => timeline.id === id))
        .filter((timeline): timeline is Timeline => !!timeline)
        .map((timeline) => ({ ...timeline, assets: props.project!.assets }))
    : [];
  const readinessState = props.project ? { ...props.state, assets: props.project.assets } : props.state;
  return (
    <TimelineReadinessGate key={timelineReadinessKey(readinessState, dependencies)} state={readinessState} dependencies={dependencies}>
      {() => <TimelineContent {...props} timelineId={timelineId} />}
    </TimelineReadinessGate>
  );
}
