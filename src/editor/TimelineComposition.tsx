import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AbsoluteFill, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ALL_FX, registerCustomFx } from '../gl/fx/effects';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
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
import { AudioClip, PlayerAudioLayers, BackgroundFillLayer, ContinuousVideoAudio, MediaFill, PlayerContinuousVideoAudioLayers, PreviewAudioEnabled, SharedVideoVisualGroup, VisualClipSurface } from './TimelineMediaLayer';
import { compositionPlan, previewLayerWindow, previewVideoMounts, type PreviewLayerRange } from './compositionPlan';
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
  previewAudioEnabled?: boolean;
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
  renderVisualLayer: (group: TimelineItem[], retainedFor?: number, audioWindowActive?: boolean) => ReactNode;
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

  const { visualRanges, transitionRanges } = useMemo(() => {
    const visualRanges: PreviewLayerRange[] = [];
    const transitionRanges: PreviewLayerRange[] = [];
    for (const layer of pictureLayers) {
      if (layer.kind === 'visual') {
        const first = layer.items[0];
        const last = layer.items.at(-1);
        if (!first || !last) continue;
        visualRanges.push({
          key: first.id,
          from: first.startFrame - (extendBefore.get(first.id) ?? 0),
          to: last.startFrame + last.durationInFrames + (extendAfter.get(last.id) ?? 0),
          selected: layer.items.some((item) => item.id === selectedItemId),
          decoderSource: layer.retainDecoder ? first.src : undefined,
        });
      } else if (layer.kind === 'transition') {
        const w = layer.window;
        transitionRanges.push({
          key: w.key, from: w.from, to: w.from + w.L,
          selected: w.incoming.id === selectedItemId || w.outgoing.id === selectedItemId,
        });
      }
    }
    return { visualRanges, transitionRanges };
  }, [pictureLayers, selectedItemId, extendBefore, extendAfter]);
  const activeVisualIds = previewLayerWindow(visualRanges, currentFrame, premountFrames);
  const activeTransitionKeys = previewLayerWindow(transitionRanges, currentFrame, premountFrames, 1);
  const [lastMounts, setLastMounts] = useState<{
    ranges: readonly PreviewLayerRange[];
    mounted: ReadonlySet<string>;
    visitedSources: ReadonlySet<string>;
  }>();
  const history = lastMounts?.ranges === visualRanges ? lastMounts : undefined;
  const retentionFrames = 4 * premountFrames;
  const { mounted, retained, visitedSources } = previewVideoMounts(
    visualRanges, activeVisualIds, currentFrame, premountFrames, retentionFrames, history,
  );
  const mountedChanged = !history || history.visitedSources !== visitedSources
    || history.mounted.size !== mounted.size || [...mounted].some((key) => !history.mounted.has(key));
  useEffect(() => {
    if (mountedChanged) {
      setLastMounts({ ranges: visualRanges, mounted, visitedSources });
    }
  }, [mountedChanged, visualRanges, mounted, visitedSources]);

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
      const last = layer.items.at(-1);
      if (first && last && (activeVisualIds.has(first.id) || retained === first.id)) {
        const windowStart = first.startFrame - (extendBefore.get(first.id) ?? 0);
        const windowEnd = last.startFrame + last.durationInFrames + (extendAfter.get(last.id) ?? 0);
        const audioWindowActive = currentFrame >= windowStart - premountFrames && currentFrame < windowEnd;
        picture.push(renderVisualLayer(layer.items, retained === first.id ? retentionFrames : undefined, audioWindowActive));
      }
    } else if (layer.kind === 'transition') {
      if (activeTransitionKeys.has(layer.window.key)) {
        picture.push(renderTransition(layer.window));
      }
    } else if (state.captionsHidden !== true && layer.entry.captions?.enabled) {
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
  const audioEnabled = useContext(PreviewAudioEnabled);
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
  const postmountFrames = environment.isPlayer ? premountFrames : 0;
  const plan = useMemo(() => compositionPlan(state, {
    mode: environment.isPlayer ? 'player' : 'render',
    selectedItemId, forceMuted, registeredEffects: ALL_FX,
  }), [state, environment.isPlayer, selectedItemId, forceMuted]);
  const {
    audio, fit, isMuted, gainAt,
    videoAudioGroups, groupedVideoIds, entranceOf, extendBefore, extendAfter,
    glWindows, glVisibilityWindows, staticPreviewStatuses, selectedEffectStaticStatus,
    pictureLayers,
  } = plan;

  const renderVisualLayer = (group: TimelineItem[], retainedFor?: number, audioWindowActive = true) => {
        const item = group[0]!;
        if (group.length > 1) return <SharedVideoVisualGroup
          key={`sv:${item.id}`} group={group} fit={fit} muted={isMuted(item.track)}
          canvasW={state.width} canvasH={state.height}
          premountFor={retainedFor ?? premountFrames} postmountFor={retainedFor ?? postmountFrames}
          browserRenderer={browserRenderer}
        />;
        const eb = extendBefore.get(item.id) ?? 0;
        const ea = extendAfter.get(item.id) ?? 0;
        const entrance = entranceOf.get(item.id);
        const fillBackground = isBackgroundFillActive(state, item);
        const foreground = (
          <ClipWrapper item={item} frameOffset={-eb}>
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
                  audioWindowActive={audioWindowActive}
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
            premountFor={retainedFor ?? premountFrames}
            postmountFor={retainedFor ?? postmountFrames}
            styleWhilePremounted={environment.isPlayer ? { opacity: 0 } : undefined}
            styleWhilePostmounted={environment.isPlayer ? { opacity: 0, pointerEvents: 'none' } : undefined}
            name={item.name}
          >
            <GlTransitionVisibility itemId={item.id} sequenceFrom={item.startFrame - eb}
              windows={glVisibilityWindows} readyWindows={readyGlWindows}>
              {entrance
                ? <PreviewTransitionIn type={entrance.type} frames={entrance.frames} dir={entrance.dir} line={entrance.line} originX={entrance.originX} originY={entrance.originY} lineColor={entrance.lineColor} lineWidthPx={entrance.lineWidthPx} isolated={entrance.isolated}>{content}</PreviewTransitionIn>
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
          postmountFor={postmountFrames}
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
            originX={w.originX} originY={w.originY} lineColor={w.lineColor} lineWidthPx={w.lineWidthPx}
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
      else if (state.captionsHidden !== true && layer.entry.captions?.enabled) picture.push(
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
      {audioEnabled && (environment.isPlayer ? <PlayerAudioLayers items={audio} timelineItems={state.items} assets={project?.assets ?? state.assets}
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
      )))}
      {audioEnabled && (environment.isPlayer ? (
        <PlayerContinuousVideoAudioLayers
          groups={videoAudioGroups}
          isMuted={isMuted}
          gainAt={gainAt}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      ) : videoAudioGroups.map((group) => (
        <ContinuousVideoAudio
          key={`audio:${group[0]!.id}`}
          items={group}
          muted={isMuted(group[0]!.track)}
          gainAt={gainAt}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      )))}
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
      {() => (
        <PreviewAudioEnabled.Provider value={!getRemotionEnvironment().isPlayer || props.previewAudioEnabled !== false}>
          <TimelineContent {...props} timelineId={timelineId} />
        </PreviewAudioEnabled.Provider>
      )}
    </TimelineReadinessGate>
  );
}
