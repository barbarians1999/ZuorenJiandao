import { copyTranscriptIdentity } from '../transcript/identity';
import type { AtomicAction, ProjectDispatch } from './reduce';
import { maxOrder, projectReduce } from './reduce';
import { sourceRevisionOf } from './mediaSourceRevision';
import { isTimelineMediaAssetKind } from './mediaTypes';
import { planOverwrite } from './overwrite';
import {
  resolveTimelineRenderPlan,
  sequenceReferenceError,
} from './sequenceGraph';
import { planSlip } from './slip';
import { planSubdraft } from './subdraft';
import { planCompactTracks } from './trackConsolidate';
import { sourceFramesToTimelineFrames } from './sourceLimit';
import { mainTrackId } from './magneticTimeline';
import { DEFAULT_COMPOSITION_MOSAIC } from './compositionMosaic';
import { resolveMediaSourceRange } from './mediaSourceRange';
import type { EditorCommands } from './storeCommands';
import { buildMediaPoolCommands } from './storeMediaPoolCommands';
import {
  activeEditorState,
  activeTimeline,
  defaultTrackId,
  isDedicatedEffectItemKind,
  isEffectItemKind,
  isEffectTrack,
  isTextTrack,
  resolveTrackId,
  timelineTrackIds,
  trackKind,
} from './types';
import type {
  Marker,
  MediaAsset,
  ProjectDoc,
  Timeline,
  TimelineItem,
  TimelineState,
  TrackId,
  TrackKind,
  TrackVisualRole,
} from './types';
import type { SelectionAction } from './selectionState';

// Ids must stay unique across sessions: items are persisted to IndexedDB, so a
// process-local counter (which resets to 0 on every reload) would regenerate ids
// that already exist and collide (e.g. split/duplicate reusing a live id →
// two items share an id → moveItem moves both). crypto.randomUUID avoids that.
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;

// The editor command set over a project dispatch fn — reused by the live store
// (real dispatch → history) and by the proposal draft engine (draft dispatch
// that records + applies to a scratch ProjectDoc without touching the real one).
export function buildCommands(
  dispatch: ProjectDispatch,
  getDoc: () => ProjectDoc,
  selectionDispatch: (action: SelectionAction) => void = dispatch,
  getLiveState?: () => TimelineState,
): EditorCommands {
  // Track creations produced while BUILDING an action (pickTrack runs inside
  // the item literal, before dispatch) are staged here and folded into the same
  // batch as that action, so "add audio to a project with no audio track" is
  // ONE undo step instead of two — previously the first undo removed the clip
  // and left an empty track behind.
  let pendingTrackCreates: AtomicAction[] = [];
  const takePendingTrackCreates = (): AtomicAction[] => {
    const pending = pendingTrackCreates;
    pendingTrackCreates = [];
    return pending;
  };
  /** dispatch that atomically includes any track created while building `action`. */
  const dispatchWithTracks = (action: AtomicAction, label: string): void => {
    const pending = takePendingTrackCreates();
    dispatch(pending.length ? { type: 'batch', label, actions: [...pending, action] } : action);
  };
  const pickTrack = (
    ref: TrackId | undefined,
    kind: TrackKind,
    visualRole?: TrackVisualRole,
    itemKind?: TimelineItem['kind'],
    strictTrack = false,
  ): TrackId => {
    const state = activeTimeline(getDoc());
    const main = mainTrackId(state);
    const effectiveRole: TrackVisualRole | undefined =
      visualRole ?? (itemKind != null && isDedicatedEffectItemKind(itemKind) ? 'effect' : undefined);
    const matchesRole = (track: TrackId): boolean => {
      if (kind !== 'video') return true;
      if (effectiveRole === 'text') return isTextTrack(state, track, main);
      if (effectiveRole === 'effect') return isEffectTrack(state, track, main);
      return !isTextTrack(state, track, main)
        && (!isEffectTrack(state, track, main) || (itemKind != null && isEffectItemKind(itemKind)));
    };
    const resolved = resolveTrackId(state, ref, kind);
    if (strictTrack && resolved && !state.tracks?.[resolved]?.locked) {
      return resolved;
    }
    const existing = resolved && matchesRole(resolved)
      ? resolved
      : effectiveRole === 'text' || effectiveRole === 'effect'
        ? timelineTrackIds(state).find((track) => trackKind(state, track) === 'video' && track !== main && matchesRole(track))
        : (() => { const d = defaultTrackId(state, kind); return d && matchesRole(d) ? d : undefined; })();
    if (existing) return existing;
    const id = uid('track');
    // Staged, not dispatched: the enclosing command commits it with its own
    // action. Any command that does not use dispatchWithTracks/placeItem still
    // gets it flushed as part of its next batch.
    pendingTrackCreates.push({ type: 'track.create', track: { id, kind, ...(effectiveRole ? { visualRole: effectiveRole } : {}) } });
    return id;
  };
  const createVideoTrackAtTop = (name: string | undefined, visualRole?: TrackVisualRole): TrackId => {
    const state = activeTimeline(getDoc());
    const id = uid('track');
    const order = timelineTrackIds(state).filter((track) => trackKind(state, track) === 'video').length;
    pendingTrackCreates.push({
      type: 'track.create',
      track: { id, kind: 'video', ...(name ? { name } : {}), ...(visualRole ? { visualRole } : {}) },
      order,
    });
    return id;
  };
  const pickEffectOverlayTrack = (
    state: TimelineState,
    name: string | undefined,
    startFrame: number,
    durationInFrames: number,
    explicitTrack?: TrackId,
    strictTrack = false,
  ): TrackId => {
    const main = mainTrackId(state);
    const resolvedExplicit = explicitTrack !== undefined && String(explicitTrack).trim() !== ''
      ? resolveTrackId(state, explicitTrack, 'video')
      : undefined;
    if (resolvedExplicit && !state.tracks?.[resolvedExplicit]?.locked) {
      if (strictTrack || isEffectTrack(state, resolvedExplicit, main)) {
        return resolvedExplicit;
      }
    }
    const endFrame = startFrame + durationInFrames;
    const free = timelineTrackIds(state).find((candidate) => candidate !== main
      && isEffectTrack(state, candidate, main) && !state.tracks?.[candidate]?.locked
      && !state.items.some((item) => item.track === candidate
        && item.startFrame < endFrame && item.startFrame + item.durationInFrames > startFrame));
    return free ?? createVideoTrackAtTop(name, 'effect');
  };
  const placeItem = (
    item: Omit<TimelineItem, 'startFrame'>,
    at: { startFrame?: number; ripple?: boolean; overwrite?: boolean } | undefined,
    before: AtomicAction[] = [],
  ) => {
    // Any track created while building `item` must land in the SAME step.
    const trackCreates = takePendingTrackCreates();
    if (!at?.overwrite) {
      const add: AtomicAction = { type: 'add', item, startFrame: at?.startFrame, ripple: at?.ripple };
      const actions = [...trackCreates, ...before, add];
      dispatch(actions.length > 1 ? { type: 'batch', label: 'Add media', actions } : add);
      return;
    }
    // Planning replaces the full state, so include staged tracks and assets
    // through the same reducer used by the eventual atomic commit.
    const doc = [...trackCreates, ...before].reduce(projectReduce, getDoc());
    const state = { ...activeTimeline(doc), assets: doc.assets };
    const plan = planOverwrite(state, item, at.startFrame ?? 0, () => uid('item'));
    if (plan) dispatch({ type: 'batch', label: 'Overwrite clip', actions: [...trackCreates, ...before, ...plan.actions] });
  };
  return {
      getState: () => getLiveState?.() ?? activeEditorState(getDoc()),
      createTimeline: (opts) => {
        const d = getDoc();
        const base = activeTimeline(d);
        const trackOrder = [uid('track')];
        const t: Timeline = {
          fps: base.fps,
          width: opts?.width ?? base.width,
          height: opts?.height ?? base.height,
          fit: opts?.fit ?? base.fit,
          items: [], selectedId: null, trackOrder,
          tracks: { [trackOrder[0]]: { kind: 'video' } },
          interaction: { mainTrackId: trackOrder[0], magnet: false, linkage: false, snapping: true },
          id: uid('tl'), name: opts?.name ?? `序列 ${d.timelines.length + 1}`, order: maxOrder(d) + 1,
        };
        dispatch({ type: 'tl.create', timeline: t, activate: opts?.activate });
        return t.id;
      },
      switchTimeline: (id) => dispatch({ type: 'tl.switch', id }),
      createSubdraft: (ids, name) => {
        const result = planSubdraft(getDoc(), ids, uid, name);
        if (!result.ok) return result;
        dispatch({ type: 'tl.setDoc', doc: result.doc });
        selectionDispatch({ type: 'select', id: result.itemId });
        return { ok: true, timelineId: result.timelineId, itemId: result.itemId };
      },
      duplicateTimeline: (id, opts) => {
        const src = getDoc().timelines.find((t) => t.id === id);
        const newId = uid('tl');
        dispatch({ type: 'tl.duplicate', id, newId, name: opts?.name ?? `${src?.name ?? '序列'} 副本`, retarget: opts?.retarget, activate: opts?.activate });
        return newId;
      },
      deleteTimeline: (id) => dispatch({ type: 'tl.delete', id }),
      renameTimeline: (id, name) => dispatch({ type: 'tl.rename', id, name }),
      retargetTimeline: (id, width, height, fit) => dispatch({ type: 'tl.retarget', id, width, height, fit }),
      setTimelineSnapping: (snapping) => dispatch({ type: 'tl.setSnapping', id: getDoc().activeTimelineId, snapping }),
      setTimelineHidden: (id, hidden) => dispatch({ type: 'tl.setHidden', id, hidden }),
      applyDoc: (doc) => dispatch({ type: 'tl.setDoc', doc }),
      batch: (actions, label) => {
        if (actions.length) dispatch({ type: 'batch', actions, label });
      },
      ...buildMediaPoolCommands(dispatch, getDoc, uid),
      addSolidItem: (at) => {
        const state = activeTimeline(getDoc());
        const startFrame = Math.max(0, Math.round(at?.startFrame ?? 0));
        const durationInFrames = Math.max(1, Math.round(at?.durationInFrames ?? Math.round(5 * state.fps)));
        const track = pickEffectOverlayTrack(state, undefined, startFrame, durationInFrames, at?.track, at?.strictTrack === true);
        const id = uid('item');
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
            track,
            durationInFrames,
            kind: 'solid',
            name: at?.name ?? '纯色',
            width: state.width,
            height: state.height,
            props: { color: at?.color ?? '#1a1a1a', ...(at?.props ?? {}) },
            ...(at?.mask ? { mask: at.mask } : {}),
          },
        }, 'Add solid');
        return id;
      },
      addShapeItem: (shape, at) => {
        const state = activeTimeline(getDoc());
        const startFrame = Math.max(0, Math.round(at?.startFrame ?? 0));
        const durationInFrames = Math.max(1, Math.round(at?.durationInFrames ?? state.fps * 3));
        const trackId = pickEffectOverlayTrack(state, undefined, startFrame, durationInFrames, at?.track);
        const id = uid('item');
        dispatchWithTracks({
          type: 'add', startFrame,
          item: {
            id, track: trackId, durationInFrames, kind: 'solid', name: shape === 'ellipse' ? '椭圆' : '矩形',
            width: state.width, height: state.height, props: { color: '#ff3b30' },
            mask: { type: shape, x: 0.35, y: 0.35, width: 0.3, height: 0.3, feather: 0 },
          },
        }, 'Add shape');
        return id;
      },
      addCompositionMosaic: (at) => {
        const state = activeTimeline(getDoc());
        const durationInFrames = Math.max(1, Math.round(at?.durationInFrames ?? state.fps * 3));
        const id = uid('item');
        const track = pickEffectOverlayTrack(state, undefined, Math.max(0, Math.round(at?.startFrame ?? 0)), durationInFrames, at?.track);
        dispatchWithTracks({
          type: 'add', startFrame: at?.startFrame,
          item: { id, track, durationInFrames, kind: 'mosaic', name: '独立马赛克', width: state.width,
            height: state.height, mosaic: { ...DEFAULT_COMPOSITION_MOSAIC } },
        }, 'Add composition mosaic');
        return id;
      },
      setCompositionMosaic: (id, patch) => dispatch({ type: 'setCompositionMosaic', id, patch }),
      setDesignStyle: (style) => dispatch({ type: 'design.set', style }),
      patchDesignStyle: (patch) => dispatch({ type: 'design.patch', patch }),
      addMotionGraphic: (tpl, at) => {
        const state = activeTimeline(getDoc());
        const startFrame = Math.max(0, Math.round(at?.startFrame ?? 0));
        const durationInFrames = typeof at?.durationInFrames === 'number' && Number.isFinite(at.durationInFrames) && at.durationInFrames >= 1
          ? Math.round(at.durationInFrames)
          : tpl.durationInFrames;
        const track = pickEffectOverlayTrack(state, undefined, startFrame, durationInFrames, at?.track, at?.strictTrack === true);
        const id = uid('item');
        const item = {
          id,
          track,
          durationInFrames,
          kind: 'motion-graphic' as const,
          templateId: tpl.id,
          name: typeof at?.name === 'string' && at.name.trim() ? at.name.trim() : tpl.name,
          code: tpl.code,
          props: { ...tpl.props, ...(at?.props ?? {}) },
          width: tpl.width,
          height: tpl.height,
        };
        placeItem(item, at);
        return id;
      },
      addAudio: (asset, at) => {
        const assets = getDoc().assets;
        const exact = assets.find((candidate) => candidate.kind === 'audio' && candidate.id === asset.id && candidate.src === asset.src);
        const sameSource = assets.filter((candidate) => candidate.kind === 'audio' && candidate.src === asset.src);
        const existing = exact ?? (sameSource.length === 1 ? sameSource[0] : undefined);
        const canonical: MediaAsset = existing ?? {
          id: assets.some((candidate) => candidate.id === asset.id) ? uid('asset') : asset.id,
          kind: 'audio',
          name: asset.name,
          sourceFilename: asset.src.split(/[?#]/, 1)[0]?.split('/').at(-1) || undefined,
          src: asset.src,
          durationInFrames: asset.durationInFrames,
        };
        const item = {
          id: uid('item'),
          track: pickTrack(at?.track, 'audio'),
          durationInFrames: asset.durationInFrames,
          kind: 'audio' as const,
          name: asset.name,
          src: asset.src,
          sourceAssetId: canonical.id,
          sourceRevision: sourceRevisionOf(canonical),
          sourceContentHash: canonical.sourceContentHash,
          sourceFilename: canonical.sourceFilename,
          originalFilePath: canonical.originalFilePath,
          volume: 1,
        };
        placeItem(item, at, existing ? [] : [{ type: 'addAsset', asset: canonical }]);
        return { itemId: item.id, sourceAssetId: canonical.id };
      },
      addTextClip: (at) => {
        const id = uid('item');
        const align = at?.align === 'left' || at?.align === 'right' ? at.align : 'center';
        const current = activeTimeline(getDoc());
        const duration = at?.durationInFrames ?? 90;
        const start = at?.startFrame ?? 0;
        // A missing V2 must not fall back to the magnetic main lane.
        let titleTrack = at?.track ? pickTrack(at.track, 'video', 'text', 'text', at.strictTrack === true)
          : timelineTrackIds(current).find((track) => track !== mainTrackId(current)
            && isTextTrack(current, track, mainTrackId(current)) && !current.tracks?.[track]?.locked
            && !current.items.some((item) => item.track === track && item.startFrame < start + duration
              && item.startFrame + item.durationInFrames > start));
        if (!titleTrack) {
          titleTrack = uid('track');
          pendingTrackCreates.push({ type: 'track.create', track: { id: titleTrack, kind: 'video', visualRole: 'text' }, order: timelineTrackIds(current).filter((track) => trackKind(current, track) === 'video').length });
        }
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
              track: titleTrack,
              durationInFrames: duration,
            kind: 'text',
            name: at?.name?.trim() || '文字',
            width: 1920,
            height: 1080,
            props: {
              text: at?.text?.trim() || '双击编辑文字',
              fontSize: typeof at?.fontSize === 'number' && Number.isFinite(at.fontSize) ? at.fontSize : 96,
              color: at?.color?.trim() || '#ffffff',
              fontWeight: typeof at?.fontWeight === 'number' && Number.isFinite(at.fontWeight) ? at.fontWeight : 700,
              align,
            },
          },
        }, 'Add title');
        return id;
      },
      addAsset: (asset: MediaAsset) => dispatch({ type: 'addAsset', asset }),
      addMediaItem: (asset, at) => {
        if (!isTimelineMediaAssetKind(asset.kind)) throw new Error(`${asset.name} is not timeline media`);
        const sourceRange = resolveMediaSourceRange(asset, at);
        const item = asset.kind === 'motion-graphic'
          ? {
              id: uid('item'),
              track: pickTrack(at?.track, 'video', undefined, 'motion-graphic'),
              durationInFrames: sourceRange?.durationInFrames ?? asset.durationInFrames,
              kind: 'motion-graphic' as const,
              templateId: asset.id,
              sourceAssetId: asset.id,
              name: asset.name,
              sourceRevision: sourceRevisionOf(asset),
              sourceContentHash: asset.sourceContentHash,
              code: asset.code,
              props: { ...asset.props },
              width: asset.width,
              height: asset.height,
            }
          : {
              id: uid('item'),
              track: pickTrack(at?.track, asset.kind === 'audio' ? 'audio' : 'video', undefined, asset.kind),
              durationInFrames: sourceRange?.durationInFrames ?? asset.durationInFrames,
              kind: asset.kind as Exclude<typeof asset.kind, 'motion-graphic'>,
              sourceAssetId: asset.id,
              name: asset.name,
              src: asset.src,
              sourceFilename: asset.sourceFilename,
              originalFilePath: asset.originalFilePath,
              sourceRevision: sourceRevisionOf(asset),
              sourceContentHash: asset.sourceContentHash,
              srcInFrame: sourceRange?.srcInFrame,
              volume: asset.kind === 'audio' || asset.kind === 'video'
                ? (typeof at?.volume === 'number' && Number.isFinite(at.volume)
                    ? Math.max(0, Math.min(2, at.volume))
                    : 1)
                : undefined,
              width: asset.width,
              height: asset.height,
              // A clip inherits a copy of the asset's ingest transcript,
              // so per-clip word edits never mutate the asset master.
              // An explicit audio source range is in ORIGINAL-source time,
              // not in the edited word stream (which strips leading silence).
              // Keep the pool transcript, but do not silently change this trim's clock.
              ...(sourceRange && asset.kind === 'audio' ? {} : copyTranscriptIdentity(asset)),
            };
        placeItem(item, at);
        return item.id;
      },
      addSequence: (timelineId, at) => {
        const doc = getDoc();
        const owner = activeTimeline(doc);
        const referenceError = sequenceReferenceError(doc, owner.id, timelineId);
        if (referenceError) {
          return { ok: false, error: referenceError.message, sequenceError: referenceError.toJSON() };
        }
        const target = doc.timelines.find((timeline) => timeline.id === timelineId);
        if (!target) return { ok: false, error: `Cannot add missing timeline ${timelineId}` };
        const sourceDuration = resolveTimelineRenderPlan(doc, timelineId).durationInFrames;
        const sourceStartFrame = Math.max(0, Math.round(at?.sourceStartFrame ?? 0));
        const availableSourceFrames = Math.max(0, sourceDuration - sourceStartFrame);
        if (availableSourceFrames <= 0) {
          return { ok: false, error: `Timeline ${timelineId} has no source frames available from frame ${sourceStartFrame}` };
        }
        const requestedSourceFrames = Math.min(
          availableSourceFrames,
          Math.max(1, at?.sourceDurationInFrames ?? availableSourceFrames),
        );
        const playbackRate = Math.max(0.1, Math.min(8, at?.playbackRate ?? 1));
        const id = uid('item');
        dispatchWithTracks({
          type: 'add',
          startFrame: at?.startFrame,
          ripple: at?.ripple,
          item: {
            id,
            track: pickTrack(at?.track, 'video'),
            durationInFrames: Math.max(1, Math.round(sourceFramesToTimelineFrames({ playbackRate }, requestedSourceFrames))),
            kind: 'sequence',
            timelineId,
            name: target.name,
            width: target.width,
            height: target.height,
            srcInFrame: sourceStartFrame,
            playbackRate,
          },
        }, 'Add sequence');
        return { ok: true, itemId: id };
      },
      updateItemProps: (id, patch) => dispatch({ type: 'updateProps', id, patch }),
      moveItem: (id, to) => {
        const item = activeTimeline(getDoc()).items.find((candidate) => candidate.id === id);
        const track = to.track && item
          ? pickTrack(to.track, item.kind === 'audio' ? 'audio' : 'video', item.kind === 'text' ? 'text' : undefined, item.kind, true)
          : to.track;
        dispatchWithTracks({ type: 'move', id, ...to, track }, 'Move clip');
      },
      setItemTiming: (id, timing) => dispatch({ type: 'retime', id, ...timing }),
      slipItem: (id, deltaInFrames) => {
        const result = planSlip(activeEditorState(getDoc()), id, deltaInFrames);
        if (result.ok && Math.abs(result.appliedDeltaInFrames) >= 1e-6) {
          dispatch({ type: 'slip', id, deltaInFrames: result.appliedDeltaInFrames });
        }
        return result;
      },
      setItemVolume: (id, volume) => dispatch({ type: 'setVolume', id, volume }),
      toggleSelectedPicture: (ids) => dispatch({ type: 'togglePicture', ids }),
      setItemDisabled: (id, disabled) => dispatch({ type: 'setItemDisabled', id, disabled }),
      setItemFade: (id, fade) => dispatch({ type: 'setFade', id, ...fade }),
      setItemTransform: (id, patch) => dispatch({ type: 'setTransform', id, patch }),
      setItemFilters: (id, patch) => dispatch({ type: 'setFilters', id, patch }),
      setItemMask: (id, mask) => dispatch({ type: 'setMask', id, mask }),
      setItemBackgroundFill: (id, enabled, strength) => dispatch({ type: 'setBackgroundFill', id, enabled, strength }),
      setItemZoom: (id, patch) => dispatch({ type: 'setZoom', id, patch }),
      setItemEffects: (id, effects, defs) => dispatch({ type: 'setEffects', id, effects, defs }),
      setItemSpeed: (id, rate) => dispatch({ type: 'setSpeed', id, rate }),
      replaceItemMedia: (id, src) => dispatch({ type: 'replaceMedia', id, src }),
      addMarker: (fromFrame, opts) => {
        const marker: Marker = {
          id: uid('mk'),
          scope: opts?.scope ?? 'project',
          itemId: opts?.itemId,
          fromFrame: Math.max(0, Math.round(fromFrame)),
          durationFrames: Math.max(0, Math.round(opts?.durationFrames ?? 0)),
          note: opts?.note ?? '',
          color: opts?.color ?? 'blue',
        };
        dispatch({ type: 'addMarker', marker });
        return marker.id;
      },
      updateMarker: (id, patch) => dispatch({ type: 'updateMarker', id, patch }),
      removeMarker: (id) => dispatch({ type: 'removeMarker', id }),
      setReframeKeyframe: (id, frame, focalPointX, focalPointY, magnification) => dispatch({ type: 'reframeKeyframe', id, frame, focalPointX, focalPointY, magnification }),
      removeReframeKeyframe: (id, frame) => dispatch({ type: 'removeReframeKeyframe', id, frame }),
      setItemKeyframe: (id, prop, frame, value, easing) => dispatch({ type: 'setKeyframe', id, prop, frame, value, easing }),
      removeItemKeyframe: (id, prop, frame) => dispatch({ type: 'removeKeyframe', id, prop, frame }),
      clearItemKeyframes: (id, prop) => dispatch({ type: 'clearKeyframes', id, prop }),
      addTransition: (incomingItemId, type, durationInFrames, custom) => {
        const id = uid('tr');
        dispatch({ type: 'addTransition', id, incomingItemId, transType: type, durationInFrames, custom });
        return id;
      },
      setTransition: (id, patch) => dispatch({ type: 'setTransition', id, patch }),
      removeTransition: (id) => dispatch({ type: 'removeTransition', id }),
      duplicateItem: (id) => dispatch({ type: 'duplicate', id, newId: uid('item') }),
      removeItem: (id) => dispatch({ type: 'remove', id }),
      rippleDeleteItem: (id) => dispatch({ type: 'remove', id, ripple: true }),
      splitItem: (id, atFrame) => dispatch({ type: 'split', id, atFrame, newId: uid('item') }),
      clearTimeline: () => dispatch({ type: 'clear' }),
      setAspect: (width, height, fit) => dispatch({ type: 'setCanvas', width, height, fit }),
      toggleTrackFlag: (track, flag) => dispatch({ type: 'toggleTrack', track, flag }),
      createTrack: (kind, opts) => {
        const id = uid('track');
        dispatch({ type: 'track.create', track: { id, kind, ...(opts?.visualRole ? { visualRole: opts.visualRole } : {}), name: opts?.name, role: opts?.role, audioRouting: opts?.audioRouting }, order: opts?.order });
        return id;
      },
      createCaptionTrack: (captions, opts) => {
        const id = uid('track');
        dispatch({
          type: 'batch',
          label: 'Create caption track',
          actions: [
            { type: 'track.create', track: { id, kind: 'caption', name: opts?.name }, order: opts?.order },
            { type: 'setCaptions', captions, track: id },
          ],
        });
        return id;
      },
      updateTrack: (track, patch) => dispatch({ type: 'track.update', track, patch }),
      deleteTracks: (tracks) => dispatch({ type: 'track.delete', tracks }),
      tightenTrack: (track) => dispatch({ type: 'track.tighten', track }),
      compactTracks: () => {
        const res = planCompactTracks(activeTimeline(getDoc()));
        if (res.movedItemCount > 0 || res.removedTrackIds.length > 0) dispatch({ type: 'track.compact' });
        return res;
      },
      setCaptions: (captions, track) => {
        const state = activeTimeline(getDoc());
        const target = track ?? defaultTrackId(state, 'caption') ?? undefined;
        if (!captions || target) {
          dispatch({ type: 'setCaptions', captions, track: target });
          return;
        }
        const id = uid('track');
        dispatch({
          type: 'batch',
          label: 'Create caption track',
          actions: [
            { type: 'track.create', track: { id, kind: 'caption' } },
            { type: 'setCaptions', captions, track: id },
          ],
        });
      },
      updateCaptions: (patch, track) => dispatch({ type: 'updateCaptions', patch, track }),
      setCaptionsHidden: (hidden) => dispatch({ type: 'setCaptionsHidden', hidden }),
      updateWatermark: (patch) => dispatch({ type: 'updateWatermark', patch }),
      setItemTranscript: (id, words) => dispatch({ type: 'setItemTranscript', id, words }),
      setAssetTranscription: (id, patch) => dispatch({ type: 'pool.setTranscription', id, patch }),
      setItemVariants: (id, variants) => dispatch({ type: 'setItemVariants', id, variants }),
      toggleWord: (id, idx) => dispatch({ type: 'toggleWord', id, idx }),
      deleteWords: (id, idxs) => dispatch({ type: 'deleteWords', id, idxs }),
      cleanScript: (id, opts) => dispatch({
        type: 'cleanScript',
        id,
        silenceFrames: opts.silenceFrames,
        removeFillers: opts.removeFillers,
        gapCapsMs: opts.gapCapsMs,
        replaceGapCaps: opts.replaceGapCaps,
      }),
      setGapCap: (id, afterWordIndex, maxMs) => dispatch({ type: 'setGapCap', id, afterWordIndex, maxMs }),
      setTranscriptPlayOrder: (id, playOrder) => dispatch({ type: 'setTranscriptPlayOrder', id, playOrder }),
      reorderTrackItems: (track, orderedIds, starts) => dispatch({ type: 'reorderTrackItems', track, orderedIds, starts }),
      toggleFoldGroup: (groupId) => dispatch({ type: 'toggleFoldGroup', groupId }),
      dissolveFoldGroup: (groupId) => dispatch({ type: 'dissolveFoldGroup', groupId }),
      splitFoldGroup: (groupId, atFrame) => dispatch({ type: 'splitFoldGroup', groupId, atFrame, newClipId: uid('clip') }),
      trimFoldGroup: (groupId, edge, deltaFrames, ripple) => dispatch({ type: 'trimFoldGroup', groupId, edge, deltaFrames, ripple }),
      dismissLegacyTimingReview: (itemId) => dispatch({ type: 'dismissLegacyTimingReview', itemId }),
      clearEdits: (id) => dispatch({ type: 'clearEdits', id }),
      fixTranscriptWord: (id, wordIndex, text) => dispatch({ type: 'fixTranscriptWord', id, wordIndex, text }),
      renameSpeaker: (id, from, to) => dispatch({ type: 'renameSpeaker', id, from, to }),
      setItemDenoise: (id, denoisedSrc, strength) => dispatch({ type: 'setItemDenoise', id, denoisedSrc, strength }),
      selectItem: (id, opts) => selectionDispatch({ type: 'select', id, mode: opts?.mode }),
      selectItems: (ids) => selectionDispatch({ type: 'selectMany', ids }),
      selectAll: () => selectionDispatch({ type: 'selectAll' }),
      applyState: (state) => dispatch({ type: 'setFullState', state }),
      applyRollingTrim: (leftId, rightId, deltaF) => dispatch({ type: 'roll', leftId, rightId, deltaF }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      beginHistoryGesture: () => dispatch({ type: 'history.beginGesture' }),
      endHistoryGesture: () => dispatch({ type: 'history.endGesture' }),
  };
}
