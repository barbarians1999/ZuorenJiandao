import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { theme } from '../../theme';
import {
  captionTrackEntries, captionsOnTrack, defaultTrackId, selectedIdsOf,
  timelineTrackIds, trackAlias, trackKind, isTextTrack, type TrackId,
} from '../../editor/types';
import { slipPreview as buildSlipPreview } from '../../editor/slip';
import { isFoldGroupVisuallyCollapsed, resolveFoldGroupSpan } from '../../editor/foldGroups';
import { mainTrackId } from '../../editor/magneticTimeline';
import { hasPotentialClipAudio } from '../../../shared/timeline-media-schedule.mjs';
import { usePersistedState } from '../../hooks/usePersistedState';
import type { FxClip } from './ClipContextMenu';
import { useRecorder } from '../../audio/recorder';
import { captionsForTrack } from '../../captions/captionTrack';
import {
  captionSelectionsInFrameRange, resolveCaptionSelection,
  type CaptionSelectionRef,
} from '../../captions/captionSelection';
import {
  moveTimelineSelectionByDelta, type TimelineSelectionMovePreview,
} from '../../captions/captionGroupMove';
import {
  createCaptionTimelineClipboard, createCaptionTrackFromClipboard,
  type CaptionTimelineClipboard,
} from '../../captions/captionTimelineClipboard';
import { newManualCaptions } from '../../captions/manualCaptions';
import { createFrameCoalescer, type FrameCoalescer } from './frameCoalescer';
import { clearHoverPreviewForActivity } from './timelineHoverPreview';
import { useTimelineShortcuts } from './useTimelineShortcuts';
import { useTimelinePointer } from './useTimelinePointer';
import { usePlayheadPaint, type AudibleAudioItem } from './usePlayheadPaint';
import { useTimelineZoomController } from './useTimelineZoomController';
import { timelineFitTotalFrames } from './timelineFitRange';
import {
  createTimelineScrubSeek, playheadScrubGrabOffsetPx,
  seekTimelineFromPointer, timelineGestureHasDragged, timelinePointerShouldSeek,
  timelinePointerStartKind, collectTimelineSeekBoundaries, snapTimelineSeekFrame, timelineSeekContinuousFrameAtClientX,
} from './timelineSeek';
import { createTimelineAutoScrollController, isPlayheadVisibleForPlaybackFollow, playbackPageScrollLeft } from './timelineAutoScroll';
import {
  HEADER_W, MAX_ROW, MIN_ROW, RULER_H, TRACK_ROW, buildTimelineIndexes,
  rulerMajorSeconds, rulerMinorCount, timelineFrameWindow, timelinePinnedItemIds,
  type EditMode, type TimelineFrameWindow,
} from './timelineUtil';
import { useT } from '../../i18n/locale';
import type { TimelineProps } from './timelineTypes';
import { useTimelineTrackMenus } from './useTimelineTrackMenus';
import { useTimelineMediaActions } from './useTimelineMediaActions';
import { timelineAttachmentFeedback } from './timelineAttachmentFeedback';
import type { TimelineState } from '../../editor/types';

const EMPTY_SELECTED_IDS: string[] = [];

export function useTimelineController({
  state, commands, playerRef, projectId, onRecordVoiceover, shortcutApiRef,
  onReviewItem, onSlipPreview, onHoverPreviewFrameChange, onScrubActiveChange,
  selectedCaptions = [], onSelectCaption = () => {}, onMarqueeCaptionSelect = () => {},
  onDropExternalFiles, onZoneChange,
}: TimelineProps) {
  const t = useT();

  const {
    items: stateItems,
    fps: stateFps,
    tracks: stateTracks,
    trackOrder: stateTrackOrder,
    captions: stateCaptions,
    transitions: stateTransitions,
    markers: stateMarkers,
  } = state;
  const total = useMemo(
    () => timelineFitTotalFrames({
      items: stateItems,
      fps: stateFps,
      tracks: stateTracks,
      trackOrder: stateTrackOrder,
      captions: stateCaptions,
    } as TimelineState),
    [stateCaptions, stateFps, stateItems, stateTrackOrder, stateTracks],
  );
  const empty = total === 0;
  const liveStateRef = useRef(state);
  liveStateRef.current = state;
  const onScrubActiveChangeRef = useRef(onScrubActiveChange);
  onScrubActiveChangeRef.current = onScrubActiveChange;
  const stateMainTrackId = state.interaction?.mainTrackId;
  const trackIds = useMemo(
    () => timelineTrackIds({
      items: stateItems,
      tracks: stateTracks,
      trackOrder: stateTrackOrder,
      captions: stateCaptions,
      interaction: stateMainTrackId ? { mainTrackId: stateMainTrackId } : undefined,
    } as TimelineState),
    [stateCaptions, stateItems, stateMainTrackId, stateTrackOrder, stateTracks],
  );
  const indexes = useMemo(
    () => buildTimelineIndexes({ items: stateItems, transitions: stateTransitions } as TimelineState),
    [stateItems, stateTransitions],
  );
  const attachmentFeedback = useMemo(() => timelineAttachmentFeedback(state), [state]);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seekGestureRef = useRef<{
    pointerId: number;
    button: number;
    startX: number;
    startY: number;
    startFrame: number | null;
    dragged: boolean;
    kind: 'blank' | 'scrub';
    seekAllowed: boolean;
    grabOffsetPx: number;
    captureTarget: HTMLElement | null;
    lineGrab: boolean;
    scrubbed: boolean;
  } | null>(null);
  const scrubSeekRef = useRef<ReturnType<typeof createTimelineScrubSeek> | null>(null);
  const scrubSeek = scrubSeekRef.current ??= createTimelineScrubSeek(
    () => playerRef.current, requestAnimationFrame, cancelAnimationFrame,
  );
  const pointerRefreshRef = useRef<(clientX: number, clientY: number) => void>(() => undefined);
  const seekClientXRef = useRef<(clientX: number, fromScroll: boolean) => void>(() => undefined);
  const pickModeRef = useRef(false);
  const autoScrollRef = useRef<ReturnType<typeof createTimelineAutoScrollController> | null>(null);
  autoScrollRef.current ??= createTimelineAutoScrollController({
    scheduler: { request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id) },
    getViewport: () => {
      const element = scrollRef.current;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const left = rect.left + element.clientLeft;
      return {
        viewportLeft: left,
        viewportRight: left + element.clientWidth,
        headerInset: HEADER_W,
        scrollLeft: element.scrollLeft,
        maxScrollLeft: Math.max(0, element.scrollWidth - element.clientWidth),
      };
    },
    setScrollLeft: (scrollLeft) => { if (scrollRef.current) scrollRef.current.scrollLeft = scrollLeft; },
    onScrolled: (gesture) => {
      pointerRefreshRef.current(gesture.clientX, gesture.clientY);
      const seek = seekGestureRef.current;
      if (seek?.kind === 'scrub' && seek.pointerId === gesture.pointerId && seek.seekAllowed && !pickModeRef.current) {
        seekClientXRef.current(gesture.clientX, true);
      }
    },
  });
  const beginAutoScroll = useCallback((pointerId: number, clientX: number, clientY: number) => {
    autoScrollRef.current?.start(pointerId, clientX, clientY);
  }, []);
  const endAutoScroll = useCallback((pointerId?: number) => {
    autoScrollRef.current?.stop(pointerId);
  }, []);
  const hoverGuideRef = useRef<HTMLDivElement | null>(null);
  const hoverPreviewFrameRef = useRef<number | null>(null);
  const hoverPreviewNotifyTimerRef = useRef<number | null>(null);
  const [captionSelectionMovePreview, setCaptionSelectionMovePreview] = useState<TimelineSelectionMovePreview | null>(null);
  const captionClipboardRef = useRef<CaptionTimelineClipboard | null>(null);
  const timelineId = (state as { id?: string }).id;
  const commitTimelineSelectionMove = useCallback((
    itemIds: readonly string[],
    captionSelections: readonly CaptionSelectionRef[],
    deltaFrames: number,
  ) => {
    setCaptionSelectionMovePreview(null);
    if (!deltaFrames) return;
    const current = liveStateRef.current;
    const next = moveTimelineSelectionByDelta(current, itemIds, captionSelections, deltaFrames);
    if (next !== current) commands.applyState(next);
  }, [commands]);
  const getPlayheadFrameRef = useRef<() => number>(() => 0);
  const { zoom, zoomMin, setZoom, zoomBy, fitToView, getExpectedScrollLeft, pixelsPerFrame: px, trackScale } =
    useTimelineZoomController({ scrollRef, totalFrames: total, fps: state.fps, projectId, timelineId, getPlayheadFrame: () => getPlayheadFrameRef.current() });
  const metaOf = (id: TrackId) => {
    const kind = trackKind(state, id);
    const color = kind === 'caption' ? theme.trackCaption
      : kind === 'video' ? theme.trackVideo
        : trackAlias(state, id) === 'A1' ? theme.trackAudioA1 : theme.trackAudioA2;
    return { kind, color };
  };
  // Playhead drawing machine: rAF frame direct drawing + Player watchdog + breakpoint resume (usePlayheadPaint)
  // Marking mode: expose the audible audio item at a playhead frame so the
  // playhead / marker placement can follow the media element's own clock during
  // playback (see usePlayheadPaint). Audio items are the source of truth for
  // beat marking; video timelines keep the wall-clock behavior.
  const audibleAudioItems = useMemo(
    () => state.items.filter((it) =>
      it.kind === 'audio' && !!it.src && hasPotentialClipAudio(it)
      && !state.tracks?.[it.track]?.muted && !state.tracks?.[it.track]?.hidden,
    ),
    [state.items, state.tracks],
  );
  const audibleAudioItemsRef = useRef(audibleAudioItems);
  audibleAudioItemsRef.current = audibleAudioItems;
  const getAudibleItem = useCallback((playheadFrame: number): AudibleAudioItem | null => {
    const candidates = audibleAudioItemsRef.current;
    if (!candidates.length) return null;
    const audible = candidates.find((it) =>
      it.kind === 'audio' && !!it.src
      && playheadFrame >= it.startFrame && playheadFrame < it.startFrame + it.durationInFrames,
    );
    if (!audible) return null;
    return {
      startFrame: audible.startFrame,
      durationInFrames: audible.durationInFrames,
      playbackRate: audible.playbackRate ?? 1,
      srcInFrame: audible.srcInFrame ?? 0,
      src: audible.src!,
    };
  }, []);
  const playbackFollowSuspendedRef = useRef(false);
  const programmaticScrollRef = useRef<{ expected: number; expiresAt: number } | null>(null);
  const onPlaybackFrameRef = useRef<(frame: number, info: { started: boolean; jumpedBack: boolean }) => void>(() => undefined);
  const {
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, syncPlayheadSeek, persistHead, setTimecodePreviewFrame, playing,
  } =
    usePlayheadPaint({
      playerRef,
      projectId,
      timelineId,
      fps: state.fps,
      total,
      px,
      scrubSeek,
      getAudibleItem,
      onPlaybackFrame: (frame, info) => onPlaybackFrameRef.current(frame, info),
    });
  getPlayheadFrameRef.current = () => playheadRef.current;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    if (!playing) playbackFollowSuspendedRef.current = false;
  }, [playing, projectId, timelineId]);
  // editing mode (Selection A / Blade B / Trim N / Pen P). selection =
  // drag/move; blade = click a clip to cut it there; trim = edge-trim ripples
  // following clips; pen = draw opacity keyframes on the selected clip.
  const [editMode, setEditMode] = usePersistedState<EditMode>('cc.editMode', 'selection');
  // insert = push later clips when dropping library media; overwrite = place without shift
  const [placeMode, setPlaceMode] = usePersistedState<'insert' | 'overwrite'>('cc.placeMode', 'insert');
  // magnetic snapping (Snapping toggle, S). On = edges lock to guides.
  const [legacySnapping] = usePersistedState('cc.snapping', true);
  const snapping = state.interaction?.snapping ?? legacySnapping;
  const setSnapping = (update: (current: boolean) => boolean) => {
    const current = commands.getState?.().interaction?.snapping ?? legacySnapping;
    commands.setTimelineSnapping(update(current));
  };
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = usePersistedState('cc.hoverPreviewEnabled', true);
  const hoverPreviewEnabledRef = useRef(hoverPreviewEnabled);
  hoverPreviewEnabledRef.current = hoverPreviewEnabled;
  const captionsVisible = state.captionsHidden !== true
    && captionTrackEntries(state).some((entry) => entry.captions?.enabled);
  const {
    captionMenu, setCaptionMenu, trackMenu, setTrackMenu, transitionMenu, setTransitionMenu,
    captionError, setCaptionError, duckMenu, setDuckMenu,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu,
  } = useTimelineTrackMenus({ state, commands, t });
  // mic voiceover recording (recording narration). Toggle to start/stop; the blob
  // is uploaded + dropped on an audio track by the parent.
  const recorder = useRecorder(onRecordVoiceover ?? (() => {}));
  const toggleCaptions = (trackId: TrackId) => {
    const current = captionsOnTrack(state, trackId);
    if (current) { commands.updateCaptions({ enabled: !current.enabled }, trackId); return; }
    const captions = captionsForTrack(state, trackId);
    commands.setCaptions(captions ?? newManualCaptions(), trackId);
  };
  // selection mode: clicks/drags pick REFERENCES for the chat
  // instead of editing — clip click → item ref, ruler click → timepoint, drag
  // over ruler/lanes → timerange. Editing gestures are untouched when off.
  const pickMode = false;
  pickModeRef.current = pickMode;
  /** Clips and caption cues whose range + track lane intersect the marquee. */
  const selectionInMarquee = (left: number, top: number, right: number, bottom: number) => {
    const f0 = frameFromClientX(left);
    const f1 = frameFromClientX(right);
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return { itemIds: [], captionSelections: [] };
    const hitTracks = new Set<TrackId>();
    const rows = innerRef.current?.querySelectorAll<HTMLElement>('[data-timeline-track-row]');
    if (rows && rows.length > 0) {
      for (const row of rows) {
        const trackId = row.dataset.timelineTrackRow;
        if (!trackId) continue;
        const rect = row.getBoundingClientRect();
        if (bottom >= rect.top && top <= rect.bottom) hitTracks.add(trackId);
      }
    } else {
      let y = r.top + RULER_H;
      for (const t of trackIds) {
        const h = rowHeightOf(t);
        if (bottom >= y && top <= y + h) hitTracks.add(t);
        y += h;
      }
    }
    const itemIds = state.items
      .filter((it) => {
        if (!hitTracks.has(it.track)) return false;
        if (state.tracks?.[it.track]?.locked) return false;
        const end = it.startFrame + it.durationInFrames;
        return end > lo && it.startFrame < hi;
      })
      .map((it) => it.id);
    const captionSelections = [...hitTracks].flatMap((trackId) => {
      if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
      const captions = captionsOnTrack(state, trackId);
      return captions
        ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, lo, hi)
        : [];
    });

    return { itemIds, captionSelections };
  };
  // clip right-click menu + effect clipboard (copy effect/paste effect)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fxClip, setFxClip] = useState<FxClip | null>(null);
  const [clientWidth, setClientWidth] = useState(0);
  const [visibleWindow, setVisibleWindow] = useState<TimelineFrameWindow>(() => timelineFrameWindow(0, 0, px, 720));
  const pxRef = useRef(px);
  pxRef.current = px;
  const windowMetaRef = useRef<{ px: number; clientWidth: number; window: TimelineFrameWindow }>({
    px,
    clientWidth: 0,
    window: timelineFrameWindow(0, 0, px, 720),
  });
  const syncVisibleWindowRef = useRef<() => void>(() => {});
  onPlaybackFrameRef.current = (frame, info) => {
    if (info.started) playbackFollowSuspendedRef.current = false;
    if (
      playbackFollowSuspendedRef.current
      || scrubSeek.pending
      || seekGestureRef.current !== null
      || autoScrollRef.current?.getActivePointerId() !== null
    ) {
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const nextScrollLeft = playbackPageScrollLeft({
      frame,
      pixelsPerFrame: pxRef.current,
      headerWidth: HEADER_W,
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
      maxScrollLeft: Math.max(0, el.scrollWidth - el.clientWidth),
      revealIfBeforeLeft: info.started || info.jumpedBack,
    });
    if (nextScrollLeft === null) return;
    const prevScrollLeft = el.scrollLeft;
    el.scrollLeft = nextScrollLeft;
    programmaticScrollRef.current = { expected: el.scrollLeft, expiresAt: performance.now() + 400 };
    if (el.scrollLeft !== prevScrollLeft) syncVisibleWindowRef.current();
  };
  // content is at least as wide as the panel, so track rows/ruler never stop
  // short of the right edge when the project is short or zoomed out.
  const innerW = Math.max(HEADER_W + total * px + 240, clientWidth);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const syncWindow = () => {
      raf = 0;
      const width = el.clientWidth;
      setClientWidth((current) => (current === width ? current : width));
      const curPx = pxRef.current;
      const scrollLeft = el.scrollLeft;
      const meta = windowMetaRef.current;
      const safePx = Math.max(curPx, 0.001);
      const viewStartPx = Math.max(0, scrollLeft - HEADER_W);
      const viewEndPx = Math.max(viewStartPx, scrollLeft + width - HEADER_W);
      const needStart = Math.max(0, Math.floor((viewStartPx - 180) / safePx));
      const needEnd = Math.max(needStart, Math.ceil((viewEndPx + 180) / safePx));
      const maxDesiredSpan = Math.ceil((width + 720 * 3) / safePx);
      const prevSpan = meta.window.endFrame - meta.window.startFrame;
      if (
        meta.px === curPx
        && meta.clientWidth === width
        && meta.window.startFrame <= needStart
        && meta.window.endFrame >= needEnd
        && prevSpan <= Math.max(maxDesiredSpan, needEnd - needStart + 1)
      ) {
        return;
      }
      const nextWindow = timelineFrameWindow(scrollLeft, width, curPx, 720);
      windowMetaRef.current = { px: curPx, clientWidth: width, window: nextWindow };
      setVisibleWindow((prev) => (
        prev.startFrame === nextWindow.startFrame && prev.endFrame === nextWindow.endFrame
          ? prev
          : nextWindow
      ));
    };
    syncVisibleWindowRef.current = () => {
      if (windowMetaRef.current.clientWidth > 0) syncWindow();
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(syncWindow); };
    // Observe the first natural layout instead of forcing one in the editor commit.
    const ro = new ResizeObserver(() => {
      if (windowMetaRef.current.clientWidth === 0 && !raf) syncWindow();
      else schedule();
    });
    ro.observe(el);
    el.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('scroll', schedule);
    };
  }, []);
  useLayoutEffect(() => {
    syncVisibleWindowRef.current();
  }, [px]);
  const effectiveVisibleWindow = useMemo(() => {
    const meta = windowMetaRef.current;
    if (meta.px !== px && meta.clientWidth > 0) {
      return timelineFrameWindow(getExpectedScrollLeft(), meta.clientWidth, px, 720);
    }
    return visibleWindow;
  }, [getExpectedScrollLeft, px, visibleWindow]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!playingRef.current || scrubSeek.pending) return;
      const programmatic = programmaticScrollRef.current;
      if (
        programmatic
        && performance.now() <= programmatic.expiresAt
        && Math.abs(el.scrollLeft - programmatic.expected) <= 2
      ) {
        programmaticScrollRef.current = null;
        return;
      }
      const visibility = isPlayheadVisibleForPlaybackFollow({
        frame: playheadRef.current,
        pixelsPerFrame: pxRef.current,
        headerWidth: HEADER_W,
        clientWidth: el.clientWidth,
        scrollLeft: el.scrollLeft,
      });
      if (visibility === 'before' || visibility === 'after') {
        playbackFollowSuspendedRef.current = true;
      } else if (visibility === 'inside') {
        playbackFollowSuspendedRef.current = false;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [playheadRef, scrubSeek, scrollRef]);

  // Equal-height tracks; scale via Alt+Shift+wheel, Alt+wheel scrolls horizontally.
  // Duck role is set via agent edit_track / track menu — not permanent track-header widgets.
  const rowHeightOf = (_id: TrackId) => {
    return Math.max(MIN_ROW, Math.min(MAX_ROW * trackScale, TRACK_ROW * trackScale));
  };
  const tracksHeight = trackIds.reduce((sum, id) => sum + rowHeightOf(id), 0);
  const majorSec = rulerMajorSeconds(px, state.fps);
  const majorFrames = Math.max(1, Math.round(majorSec * state.fps));
  const minorDivs = rulerMinorCount(majorSec) + 1; // subdivisions between majors
  const minorFrames = Math.max(1, Math.round(majorFrames / minorDivs));
  const minorTicksPerMajor = Math.max(1, Math.round(majorFrames / minorFrames) - 1);
  const rulerSpanFrames = Math.max(total, Math.ceil((innerW - HEADER_W) / Math.max(px, 0.001)));

  const frameFromClientX = useCallback((clientX: number): number => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.round((clientX - r.left - HEADER_W) / px));
  }, [px]);
  const trackFromClientY = (clientY: number): TrackId => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return defaultTrackId(state, 'video') ?? defaultTrackId(state, 'audio') ?? '';
    const rows = innerRef.current?.querySelectorAll<HTMLElement>('[data-timeline-track-row]');
    if (rows && rows.length > 0) {
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (clientY <= rect.bottom) return row.dataset.timelineTrackRow || (trackIds[0] ?? '');
      }
      return rows[rows.length - 1]?.dataset.timelineTrackRow || (trackIds[trackIds.length - 1] ?? '');
    }
    let y = clientY - r.top - RULER_H;
    for (const t of trackIds) {
      y -= rowHeightOf(t);
      if (y < 0) return t;
    }
    return trackIds[trackIds.length - 1] ?? '';
  };

  const copyCaptionSelections = (selections = selectedCaptions): boolean => {
    const clipboard = createCaptionTimelineClipboard(selections.flatMap((selection) => {
      const cue = resolveCaptionSelection(state, selection)?.target.cue;
      return cue ? [{ text: cue.text, start: cue.start, end: cue.end }] : [];
    }));
    if (!clipboard) return false;
    captionClipboardRef.current = clipboard;
    return true;
  };
  const pasteCaptionClipboard = (): boolean => {
    const captions = createCaptionTrackFromClipboard(
      captionClipboardRef.current,
      playheadRef.current * 1000 / state.fps,
    );
    if (!captions) return false;
    const trackId = `track_${crypto.randomUUID()}`;
    commands.batch([
      { type: 'track.create', track: { id: trackId, kind: 'caption', name: t('复制字幕') } },
      { type: 'setCaptions', captions, track: trackId },
    ], t('粘贴字幕'));
    return true;
  };

  // Pointer state machine: fragment drag/crop, blank frame selection, pen point drag, reference picking (useTimelinePointer)
  const pointer = useTimelinePointer({
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, selectionInMarquee,
    selectedCaptions, onMarqueeCaptionSelect,
    onGestureStart: beginAutoScroll,
    onGestureEnd: endAutoScroll,
  });
  pointerRefreshRef.current = pointer.refreshAt;
  const { drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel } = pointer;
  const activeSelectionMovePreview: TimelineSelectionMovePreview | null = captionSelectionMovePreview ?? (
    drag?.mode === 'move' && pointer.dragSelection.captionSelections.length > 0
      ? {
          itemIds: pointer.dragSelection.itemIds,
          captionSelections: pointer.dragSelection.captionSelections,
          deltaFrames: drag.deltaF,
        }
      : null
  );
  const activeSlipPreview = useMemo(
    () => drag?.mode === 'slip' ? buildSlipPreview(state, drag.id, drag.deltaF) : null,
    [drag, state],
  );
  useEffect(() => {
    onSlipPreview?.(activeSlipPreview);
  }, [activeSlipPreview, onSlipPreview]);
  useEffect(() => () => onSlipPreview?.(null), [onSlipPreview]);

  const {
    relinkInputRef, trackInsertInputRef, clipJob, setClipJob,
    libDropTarget, setLibDropTarget, beginRelink, relinkFile,
    beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    applyLibraryToClip, applyLibraryToTrack,
  } = useTimelineMediaActions({
    state, commands, liveStateRef, onDropExternalFiles, placeMode, t,
  });

  const seekBoundaries = useMemo(
    () => collectTimelineSeekBoundaries({
      items: stateItems,
      markers: stateMarkers,
      tracks: stateTracks,
      trackOrder: stateTrackOrder,
      captions: stateCaptions,
      fps: stateFps,
    } as TimelineState),
    [stateCaptions, stateFps, stateItems, stateMarkers, stateTrackOrder, stateTracks],
  );
  const seekPointerFrame = (frame: number) => {
    playbackFollowSuspendedRef.current = false;
    clearHoverPreview();
    const clamped = Math.max(0, Math.min(frame, total - 1));
    seekTimelineFromPointer(playerRef.current, clamped, syncPlayheadSeek);
  };

  const scrubFrameAtClientX = (clientX: number) => {
    const rect = innerRef.current?.getBoundingClientRect();
    const raw = rect && px > 0 ? Math.max(0, (clientX - rect.left - HEADER_W) / px) : frameFromClientX(clientX);
    return snapTimelineSeekFrame(raw, seekBoundaries, { pixelsPerFrame: px, totalFrames: total, snapping });
  };
  const seekTo = (clientX: number) => {
    playbackFollowSuspendedRef.current = false;
    clearHoverPreview();
    const frame = scrubFrameAtClientX(clientX);
    scrubSeek.commit(frame, syncPlayheadSeek);
    return frame;
  };
  const scrubTo = (clientX: number, fromScroll = false) => {
    const gesture = seekGestureRef.current;
    if (gesture?.kind !== 'scrub' || !gesture.seekAllowed || pickModeRef.current) return;
    if (!gesture.scrubbed) {
      if (gesture.lineGrab && !fromScroll && Math.abs(clientX - gesture.startX) < 1) return;
      gesture.scrubbed = true;
      onScrubActiveChangeRef.current?.(true);
    }
    scrubSeek.move(scrubFrameAtClientX(clientX - gesture.grabOffsetPx), syncPlayheadSeek);
  };
  seekClientXRef.current = scrubTo;

  const revealPlayheadInViewport = (frame: number) => {
    const el = scrollRef.current;
    if (!el || el.clientWidth <= HEADER_W + 48) return;
    const x = HEADER_W + frame * px;
    const viewLeft = el.scrollLeft + HEADER_W;
    const viewRight = el.scrollLeft + el.clientWidth;
    if (x >= viewLeft + 24 && x <= viewRight - 24) return;
    const usable = Math.max(40, el.clientWidth - HEADER_W);
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, frame * px - usable * 0.35));
    el.scrollLeft = nextScrollLeft;
    programmaticScrollRef.current = { expected: el.scrollLeft, expiresAt: performance.now() + 400 };
    syncVisibleWindowRef.current();
  };

  const seekFrame = (f: number) => {
    playbackFollowSuspendedRef.current = false;
    clearHoverPreview();
    scrubSeek.cancel();
    const c = Math.max(0, Math.min(f, total - 1));
    playerRef.current?.seekTo(c);
    syncPlayheadSeek(c);
    revealPlayheadInViewport(c);
  };

  const frameAtClientX = (clientX: number) => {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const raw = timelineSeekContinuousFrameAtClientX(clientX, {
      contentLeft: rect.left,
      headerWidth: HEADER_W,
      pixelsPerFrame: px,
      totalFrames: total,
    });
    return raw === null ? null : snapTimelineSeekFrame(raw, seekBoundaries, { pixelsPerFrame: px, totalFrames: total, snapping });
  };
  // Hover updates are coalesced to one per animation frame, the way the drag
  // path in useTimelinePointer already is. The browser delivers each pointer
  // report in its own task, so without this the timeline, the timecode and the
  // preview panel all committed once per report — measured at 890 DOM mutations
  // over 60 moves, against 200 once coalesced.
  const hoverFrames = useRef<FrameCoalescer<number> | null>(null);
  hoverFrames.current ??= createFrameCoalescer<number>(requestAnimationFrame, cancelAnimationFrame);
  const paintHoverGuide = (frame: number | null) => {
    const el = hoverGuideRef.current;
    if (!el) return;
    if (frame === null) {
      el.style.display = 'none';
      el.style.transform = '';
    } else {
      el.style.display = '';
      el.style.transform = `translate3d(${HEADER_W + frame * pxRef.current}px,0,0)`;
    }
  };
  const clearHoverPreview = () => {
    hoverFrames.current?.cancel();
    if (hoverPreviewNotifyTimerRef.current !== null) {
      window.clearTimeout(hoverPreviewNotifyTimerRef.current);
      hoverPreviewNotifyTimerRef.current = null;
    }
    if (hoverPreviewFrameRef.current === null) return;
    hoverPreviewFrameRef.current = null;
    paintHoverGuide(null);
    setTimecodePreviewFrame(null);
    onHoverPreviewFrameChange?.(null);
  };
  const clearHoverPreviewRef = useRef(clearHoverPreview);
  clearHoverPreviewRef.current = clearHoverPreview;
  const applyHoverPreview = (clientX: number) => {
    if (!hoverPreviewEnabledRef.current) { clearHoverPreview(); return; }
    const frame = frameAtClientX(clientX);
    if (frame === hoverPreviewFrameRef.current) return;
    hoverPreviewFrameRef.current = frame;
    paintHoverGuide(frame);
    setTimecodePreviewFrame(frame);
    if (hoverPreviewNotifyTimerRef.current !== null) {
      window.clearTimeout(hoverPreviewNotifyTimerRef.current);
      hoverPreviewNotifyTimerRef.current = null;
    }
    if (frame === null) {
      onHoverPreviewFrameChange?.(null);
    } else {
      hoverPreviewNotifyTimerRef.current = window.setTimeout(() => {
        hoverPreviewNotifyTimerRef.current = null;
        if (hoverPreviewFrameRef.current === frame) {
          onHoverPreviewFrameChange?.(frame);
        }
      }, 110);
    }
  };
  useLayoutEffect(() => {
    if (hoverPreviewFrameRef.current !== null) paintHoverGuide(hoverPreviewFrameRef.current);
  }, [px]);
  const updateHoverPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Clearing stays synchronous: the moment a drag or playback starts, the
    // stale hover marker has to go, and dropping it a frame late is visible.
    if (clearHoverPreviewForActivity({
      hoverPreviewEnabled, playing, pointerButtons: event.buttons, drag, marquee, pickDrag,
    }, clearHoverPreview)) return;
    hoverFrames.current?.schedule(event.clientX, applyHoverPreview);
  };
  // A scheduled frame must not fire after unmount.
  useEffect(() => {
    const coalescer = hoverFrames.current;
    return () => {
      coalescer?.cancel();
      if (hoverPreviewNotifyTimerRef.current !== null) {
        window.clearTimeout(hoverPreviewNotifyTimerRef.current);
        hoverPreviewNotifyTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    clearHoverPreviewForActivity(
      { hoverPreviewEnabled, playing, drag, marquee, pickDrag },
      clearHoverPreviewRef.current,
    );
  }, [hoverPreviewEnabled, playing, drag, marquee, pickDrag]);
  const startSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (seekGestureRef.current?.scrubbed) {
      scrubSeek.cancel(paintPlayhead);
      onScrubActiveChangeRef.current?.(false);
    }
    seekGestureRef.current = null;
    if (!target) return;
    const playheadGrip = target.closest('.cc-playhead-grip, .cc-playhead-line-grip') as HTMLElement | null;
    const playheadLineGrip = target.closest('.cc-playhead-line-grip') as HTMLElement | null;
    const ruler = target.closest('.cc-timeline-ruler') as HTMLElement | null;
    const trackLane = target.closest('.cc-track-lane, .cc-caption-track-lane, .cc-new-track-drop');
    const ownedControl = !!target.closest(
      '.cc-ruler-head, [data-timeline-clip], [data-roll-handle], .cc-caption-track-cue, .cc-caption-track-trim, .cc-track-head, .cc-transition-marker, button, input, select, textarea, [contenteditable="true"], [data-caption-selection-owner]',
    );
    const kind = timelinePointerStartKind({
      button: event.button,
      playheadGrip: !!playheadGrip,
      ruler: !!ruler,
      trackLane: !!trackLane,
      ownedControl,
    });

    if (kind === 'scrub') {
      clearHoverPreview();
      const captureTarget = playheadGrip ?? ruler;
      if (!captureTarget) return;
      const rect = playheadLineGrip ? innerRef.current?.getBoundingClientRect() : null;
      const grabOffsetPx = playheadLineGrip && rect
        ? playheadScrubGrabOffsetPx(event.clientX, rect.left + HEADER_W + playheadRef.current * px)
        : 0;
      seekGestureRef.current = {
        pointerId: event.pointerId, button: event.button, startX: event.clientX, startY: event.clientY,
        startFrame: null, dragged: false, kind: 'scrub', seekAllowed: !pickModeRef.current, grabOffsetPx, captureTarget,
        lineGrab: !!playheadLineGrip, scrubbed: false,
      };
      beginAutoScroll(event.pointerId, event.clientX, event.clientY);
      return;
    }
    if (kind !== 'blank') return;
    clearHoverPreview();
    seekGestureRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frameAtClientX(event.clientX),
      dragged: false,
      kind: 'blank',
      seekAllowed: !pickModeRef.current,
      grabOffsetPx: 0,
      captureTarget: null,
      lineGrab: false,
      scrubbed: false,
    };
  };
  const updateSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = seekGestureRef.current;
    if (gesture?.pointerId === event.pointerId && !gesture.dragged) {
      gesture.dragged = timelineGestureHasDragged(gesture.startX, gesture.startY, event.clientX, event.clientY);
    }
    autoScrollRef.current?.update(event.pointerId, event.clientX, event.clientY);
  };
  const finishSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = seekGestureRef.current;
    if (gesture?.pointerId === event.pointerId) {
      seekGestureRef.current = null;
      if (gesture.kind === 'blank' && gesture.seekAllowed
        && timelinePointerShouldSeek(gesture.button, pickModeRef.current, gesture.dragged)) {
        const frame = gesture.startFrame ?? frameAtClientX(event.clientX);
        if (frame !== null) {
          seekPointerFrame(frame);
          persistHead(frame);
        }
      } else if (gesture.kind === 'scrub' && gesture.seekAllowed && !pickModeRef.current
        && gesture.captureTarget?.hasPointerCapture(event.pointerId)) {
        if (gesture.scrubbed || gesture.dragged || (gesture.lineGrab && Math.abs(event.clientX - gesture.startX) >= 1)) {
          persistHead(seekTo(event.clientX - gesture.grabOffsetPx));
        } else if (!gesture.lineGrab) {
          persistHead(playheadRef.current);
        } else {
          scrubSeek.cancel(paintPlayhead);
        }
      } else if (gesture.kind === 'scrub') {
        scrubSeek.cancel(paintPlayhead);
      }
      if (gesture.scrubbed) onScrubActiveChangeRef.current?.(false);
    }
    endAutoScroll(event.pointerId);
  };
  const cancelSeekGesture = (event?: ReactPointerEvent) => {
    const gesture = seekGestureRef.current;
    if (gesture && (!event || gesture.pointerId === event.pointerId)) {
      seekGestureRef.current = null;
      scrubSeek.cancel(paintPlayhead);
      if (gesture.scrubbed) onScrubActiveChangeRef.current?.(false);
    }
    endAutoScroll(event?.pointerId ?? gesture?.pointerId);
  };
  const cancelSeekGestureRef = useRef(cancelSeekGesture);
  cancelSeekGestureRef.current = cancelSeekGesture;
  useLayoutEffect(() => {
    const releaseCapture = (gesture: typeof seekGestureRef.current) => {
      if (gesture?.captureTarget?.hasPointerCapture(gesture.pointerId)) {
        try { gesture.captureTarget.releasePointerCapture(gesture.pointerId); } catch { /* capture may already be gone */ }
      }
    };
    const cancel = () => {
      const gesture = seekGestureRef.current;
      cancelSeekGestureRef.current();
      releaseCapture(gesture);
      clearHoverPreviewRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !seekGestureRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancel);
    return () => {
      const gesture = seekGestureRef.current;
      seekGestureRef.current = null;
      scrubSeek.cancel();
      if (gesture?.scrubbed) onScrubActiveChangeRef.current?.(false);
      autoScrollRef.current?.dispose();
      releaseCapture(gesture);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancel);
    };
  }, [projectId, timelineId, scrubSeek]);
  useEffect(() => () => onHoverPreviewFrameChange?.(null), [onHoverPreviewFrameChange]);

  // blade (B / Ctrl+B): split the selected clip (or collapsed fold group) at the playhead.
  const bladeSelected = () => {
    const currentState = commands.getState?.() ?? liveStateRef.current;
    const frame = Math.round(playheadRef.current);
    const trySplit = (item: (typeof currentState.items)[number]): boolean => {
      if (currentState.tracks?.[item.track]?.locked) return false;
      const group = currentState.foldGroups?.find((entry) => entry.itemIds.includes(item.id));
      if (group && isFoldGroupVisuallyCollapsed(group)) {
        const span = resolveFoldGroupSpan(currentState, group);
        if (span && frame > span.startFrame && frame < span.startFrame + span.durationInFrames) {
          commands.splitFoldGroup(group.id, frame);
          return true;
        }
        return false;
      }
      if (frame > item.startFrame && frame < item.startFrame + item.durationInFrames) {
        commands.splitItem(item.id, frame);
        return true;
      }
      return false;
    };
    const isSplittable = (item: (typeof currentState.items)[number]) => {
      if (currentState.tracks?.[item.track]?.locked) return false;
      const group = currentState.foldGroups?.find((entry) => entry.itemIds.includes(item.id));
      if (group && isFoldGroupVisuallyCollapsed(group)) {
        const span = resolveFoldGroupSpan(currentState, group);
        return !!span && frame > span.startFrame && frame < span.startFrame + span.durationInFrames;
      }
      return frame > item.startFrame && frame < item.startFrame + item.durationInFrames;
    };
    const primary = currentState.selectedId
      ? currentState.items.find((item) => item.id === currentState.selectedId)
      : undefined;
    if (primary && trySplit(primary)) return;
    const selectedSplittable = selectedIdsOf(currentState)
      .map((id) => currentState.items.find((item) => item.id === id))
      .find((item): item is (typeof currentState.items)[number] => !!item && isSplittable(item));
    if (selectedSplittable && trySplit(selectedSplittable)) return;
    const main = mainTrackId(currentState);
    const fallback = (main ? currentState.items.find((item) => item.track === main && isSplittable(item)) : undefined)
      ?? currentState.items.find((item) => !isTextTrack(currentState, item.track, main) && isSplittable(item))
      ?? currentState.items.find(isSplittable);
    if (fallback) trySplit(fallback);
  };
  // markers (manage_markers): add at the playhead + open its note editor
  const [editMarker, setEditMarker] = useState<string | null>(null);
  const markers = state.markers ?? [];
  // Shortcut API assembly + I/O interval/JKL shuttle/fragment clipboard (the whole machine is in useTimelineShortcuts)
  const { zoneIn, zoneOut } = useTimelineShortcuts({
    shortcutApiRef, state, commands, playerRef, playheadRef, total,
    seekFrame, paintPlayhead, cancelPendingScrubSeek: () => scrubSeek.cancel(),
    editMode, setEditMode, selectedCaptions, setSnapping, fitToView, zoomBy,
    bladeSelected, setEditMarker, fxClip, setFxClip,
    copySelectedCaptions: copyCaptionSelections, pasteCaptionClipboard,
    onSelectCaptionRange: onMarqueeCaptionSelect,
  });
  useEffect(() => {
    onZoneChange?.({ inFrame: zoneIn, outFrame: zoneOut });
  }, [onZoneChange, zoneIn, zoneOut]);

  const editing = markers.find((m) => m.id === editMarker) ?? null;
  const selectedIdsKey = selectedIdsOf(state).join('\u0000');
  const selectedIds = useMemo(
    () => (selectedIdsKey ? selectedIdsKey.split('\u0000') : EMPTY_SELECTED_IDS),
    [selectedIdsKey],
  );
  const pinnedItemIds = useMemo(() => timelinePinnedItemIds(
    selectedIds,
    [drag?.id, drag?.rightId, pointer.penDrag?.itemId, ctxMenu?.id, libDropTarget, pickDrag?.item?.id,
      ...((drag?.plannedState?.items ?? []).flatMap((next) => {
        const previous = indexes.itemById.get(next.id);
        return previous && (previous.startFrame !== next.startFrame || previous.durationInFrames !== next.durationInFrames
          || previous.track !== next.track || previous.srcInFrame !== next.srcInFrame) ? [next.id] : [];
      }))],
    stateTransitions ?? [],
  ), [
    ctxMenu?.id, drag?.id, drag?.plannedState, drag?.rightId, indexes, libDropTarget, pickDrag?.item?.id,
    pointer.penDrag?.itemId, selectedIds, stateTransitions,
  ]);

  return {
    state, commands, playerRef, onRecordVoiceover, onReviewItem, onDropExternalFiles,
    selectedCaptions, onSelectCaption, onMarqueeCaptionSelect,
    t, total, empty, trackIds, indexes, attachmentFeedback, innerRef, scrollRef,
    relinkInputRef, trackInsertInputRef,
    hoverGuideRef, captionSelectionMovePreview, setCaptionSelectionMovePreview,
    commitTimelineSelectionMove, zoom, zoomMin, setZoom, px, trackScale, metaOf,
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, playing, editMode, placeMode, setPlaceMode, snapping, hoverPreviewEnabled, setHoverPreviewEnabled,
    captionsVisible, captionMenu, setCaptionMenu, trackMenu, setTrackMenu, transitionMenu, setTransitionMenu,
    duckMenu, setDuckMenu, captionError, setCaptionError,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu, recorder, toggleCaptions,
    pickMode, ctxMenu, setCtxMenu, fxClip, setFxClip, clipJob, setClipJob,
    beginRelink, relinkFile, beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    innerW, visibleWindow: effectiveVisibleWindow, rowHeightOf, tracksHeight,
    majorFrames, minorFrames, minorTicksPerMajor, rulerSpanFrames,
    frameFromClientX, trackFromClientY, copyCaptionSelections, pasteCaptionClipboard,
    pointer, drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel,
    cancelSeekGesture,
    activeSelectionMovePreview, libDropTarget, setLibDropTarget,
    applyLibraryToClip, applyLibraryToTrack, seekTo, scrubTo, seekFrame,
    clearHoverPreview, updateHoverPreview, startSeekGesture, updateSeekGesture, finishSeekGesture,
    markers, zoneIn, zoneOut, editing, editMarker, setEditMarker, pinnedItemIds,
  };
}
