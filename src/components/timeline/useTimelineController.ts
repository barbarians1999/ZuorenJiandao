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
import { mainTrackId } from '../../editor/magneticTimeline';
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
  playheadScrubGrabOffsetPx,
  seekTimelineFromPointer, timelineGestureHasDragged, timelinePointerShouldSeek,
  timelinePointerStartKind, collectTimelineSeekBoundaries, snapTimelineSeekFrame, timelineSeekContinuousFrameAtClientX,
} from './timelineSeek';
import { createTimelineAutoScrollController } from './timelineAutoScroll';
import {
  HEADER_W, MAX_ROW, MIN_ROW, RULER_H, TRACK_ROW, buildTimelineIndexes,
  rulerMajorSeconds, rulerMinorCount, timelineFrameWindow, timelinePinnedItemIds,
  type EditMode, type TimelineFrameWindow,
} from './timelineUtil';
import { useT } from '../../i18n/locale';
import type { TimelineProps } from './timelineTypes';
import { useTimelineTrackMenus } from './useTimelineTrackMenus';
import { useTimelineMediaActions } from './useTimelineMediaActions';

export function useTimelineController({
  state, commands, playerRef, projectId, onRecordVoiceover, shortcutApiRef,
  onReviewItem, onSlipPreview, onHoverPreviewFrameChange,
  selectedCaptions = [], onSelectCaption = () => {}, onMarqueeCaptionSelect = () => {},
  onDropExternalFiles, onZoneChange,
}: TimelineProps) {
  const t = useT();

  const total = useMemo(() => timelineFitTotalFrames(state), [state]);
  const empty = total === 0;
  const liveStateRef = useRef(state);
  liveStateRef.current = state;
  const trackIds = timelineTrackIds(state);
  const indexes = useMemo(
    () => buildTimelineIndexes(state),
    [state],
  );
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seekGestureRef = useRef<{
    pointerId: number;
    button: number;
    startX: number;
    startY: number;
    dragged: boolean;
    kind: 'blank' | 'scrub';
    seekAllowed: boolean;
    grabOffsetPx: number;
    captureTarget: HTMLElement | null;
  } | null>(null);
  const pointerRefreshRef = useRef<(clientX: number, clientY: number) => void>(() => undefined);
  const seekClientXRef = useRef<(clientX: number) => void>(() => undefined);
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
      if (seek?.kind === 'scrub' && seek.pointerId === gesture.pointerId && seek.seekAllowed
        && !pickModeRef.current) seekClientXRef.current(gesture.clientX - seek.grabOffsetPx);
    },
  });
  const beginAutoScroll = useCallback((pointerId: number, clientX: number, clientY: number) => {
    autoScrollRef.current?.start(pointerId, clientX, clientY);
  }, []);
  const endAutoScroll = useCallback((pointerId?: number) => {
    autoScrollRef.current?.stop(pointerId);
  }, []);
  const [hoverPreviewFrame, setHoverPreviewFrame] = useState<number | null>(null);
  const hoverPreviewFrameRef = useRef<number | null>(null);
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
  const { zoom, zoomMin, setZoom, zoomBy, fitToView, pixelsPerFrame: px, trackScale } =
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
  const getAudibleItem = useCallback((playheadFrame: number): AudibleAudioItem | null => {
    const s = liveStateRef.current;
    const audible = s.items.find((it) =>
      it.kind === 'audio' && !!it.src && (it.volume ?? 1) > 0
      && playheadFrame >= it.startFrame && playheadFrame < it.startFrame + it.durationInFrames
      && !s.tracks?.[it.track]?.muted && !s.tracks?.[it.track]?.hidden,
    );
    if (!audible) return null;
    return {
      startFrame: audible.startFrame,
      playbackRate: audible.playbackRate ?? 1,
      srcInFrame: audible.srcInFrame ?? 0,
      src: audible.src!,
    };
  }, []);
  const {
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, setTimecodePreviewFrame, playing,
  } =
    usePlayheadPaint({ playerRef, projectId, timelineId, fps: state.fps, total, px, getAudibleItem });
  getPlayheadFrameRef.current = () => playheadRef.current;
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
  const textClipCount = state.items.filter((item) => item.kind === 'text' || item.kind === 'motion-graphic').length;
  const captionsVisible = state.captionsHidden === true
    ? false
    : state.captionsHidden === false
      ? true
      : captionTrackEntries(state).some((entry) => entry.captions?.enabled) || textClipCount > 0;
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
      setVisibleWindow(nextWindow);
    };
    syncVisibleWindowRef.current = syncWindow;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(syncWindow); };
    syncWindow();
    const ro = new ResizeObserver(schedule);
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

  const seekBoundaries = useMemo(() => collectTimelineSeekBoundaries(state), [state]);
  const seekPointerFrame = (frame: number) => {
    const clamped = Math.max(0, Math.min(frame, total - 1));
    seekTimelineFromPointer(playerRef.current, clamped, paintPlayhead);
  };

  const seekTo = (clientX: number) => {
    const rect = innerRef.current?.getBoundingClientRect();
    const raw = rect && px > 0 ? Math.max(0, (clientX - rect.left - HEADER_W) / px) : frameFromClientX(clientX);
    seekPointerFrame(snapTimelineSeekFrame(raw, seekBoundaries, { pixelsPerFrame: px, totalFrames: total, snapping }));
  };
  seekClientXRef.current = seekTo;

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
    syncVisibleWindowRef.current();
  };

  const seekFrame = (f: number) => {
    const c = Math.max(0, Math.min(f, total - 1));
    playerRef.current?.seekTo(c);
    paintPlayhead(c);
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
  const clearHoverPreview = () => {
    hoverFrames.current?.cancel();
    if (hoverPreviewFrameRef.current === null) return;
    hoverPreviewFrameRef.current = null;
    setHoverPreviewFrame(null);
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
    setHoverPreviewFrame(frame);
    setTimecodePreviewFrame(frame);
    onHoverPreviewFrameChange?.(frame);
  };
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
    return () => coalescer?.cancel();
  }, []);
  useEffect(() => {
    clearHoverPreviewForActivity(
      { hoverPreviewEnabled, playing, drag, marquee, pickDrag },
      clearHoverPreviewRef.current,
    );
  }, [hoverPreviewEnabled, playing, drag, marquee, pickDrag]);
  const startSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
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
      const captureTarget = playheadGrip ?? ruler;
      if (!captureTarget) return;
      const rect = playheadLineGrip ? innerRef.current?.getBoundingClientRect() : null;
      const grabOffsetPx = playheadLineGrip && rect
        ? playheadScrubGrabOffsetPx(event.clientX, rect.left + HEADER_W + playheadRef.current * px)
        : 0;
      seekGestureRef.current = {
        pointerId: event.pointerId, button: event.button, startX: event.clientX, startY: event.clientY,
        dragged: false, kind: 'scrub', seekAllowed: !pickModeRef.current, grabOffsetPx, captureTarget,
      };
      beginAutoScroll(event.pointerId, event.clientX, event.clientY);
      return;
    }
    if (kind !== 'blank') return;
    seekGestureRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false,
      kind: 'blank',
      seekAllowed: !pickModeRef.current,
      grabOffsetPx: 0,
      captureTarget: null,
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
        const frame = frameAtClientX(event.clientX);
        if (frame !== null) seekPointerFrame(frame);
      }
    }
    endAutoScroll(event.pointerId);
  };
  const cancelSeekGesture = (event?: ReactPointerEvent) => {
    const gesture = seekGestureRef.current;
    if (gesture && (!event || gesture.pointerId === event.pointerId)) seekGestureRef.current = null;
    endAutoScroll(event?.pointerId ?? gesture?.pointerId);
  };
  useEffect(() => {
    const cancel = () => {
      const gesture = seekGestureRef.current;
      seekGestureRef.current = null;
      endAutoScroll(gesture?.pointerId);
      if (gesture?.captureTarget?.hasPointerCapture(gesture.pointerId)) {
        try { gesture.captureTarget.releasePointerCapture(gesture.pointerId); } catch { /* capture may already be gone */ }
      }
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
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancel);
      autoScrollRef.current?.dispose();
    };
  }, [endAutoScroll]);
  useEffect(() => () => onHoverPreviewFrameChange?.(null), [onHoverPreviewFrameChange]);

  // blade (B): split the selected clip at the playhead. splitItem no-ops if the
  // playhead is outside the clip, so no guard needed here.
  const bladeSelected = () => {
    const frame = playheadRef.current;
    const isSplittable = (item: (typeof state.items)[number]) =>
      !state.tracks?.[item.track]?.locked
      && frame > item.startFrame
      && frame < item.startFrame + item.durationInFrames;
    const primary = state.selectedId ? indexes.itemById.get(state.selectedId) : undefined;
    if (primary && isSplittable(primary)) {
      commands.splitItem(primary.id, frame);
      return;
    }
    const selectedSplittable = selectedIdsOf(state)
      .map((id) => indexes.itemById.get(id))
      .find((item): item is (typeof state.items)[number] => !!item && isSplittable(item));
    if (selectedSplittable) {
      commands.splitItem(selectedSplittable.id, frame);
      return;
    }
    const main = mainTrackId(state);
    const fallback = (main ? state.items.find((item) => item.track === main && isSplittable(item)) : undefined)
      ?? state.items.find((item) => !isTextTrack(state, item.track, main) && isSplittable(item))
      ?? state.items.find(isSplittable);
    if (fallback) commands.splitItem(fallback.id, frame);
  };
  // markers (manage_markers): add at the playhead + open its note editor
  const [editMarker, setEditMarker] = useState<string | null>(null);
  const markers = state.markers ?? [];
  // Shortcut API assembly + I/O interval/JKL shuttle/fragment clipboard (the whole machine is in useTimelineShortcuts)
  const { zoneIn, zoneOut } = useTimelineShortcuts({
    shortcutApiRef, state, commands, playerRef, playheadRef, total,
    seekFrame, paintPlayhead, editMode, setEditMode, selectedCaptions, setSnapping, fitToView, zoomBy,
    bladeSelected, setEditMarker, fxClip, setFxClip,
    copySelectedCaptions: copyCaptionSelections, pasteCaptionClipboard,
    onSelectCaptionRange: onMarqueeCaptionSelect,
  });
  useEffect(() => {
    onZoneChange?.({ inFrame: zoneIn, outFrame: zoneOut });
  }, [onZoneChange, zoneIn, zoneOut]);

  const editing = markers.find((m) => m.id === editMarker) ?? null;
  const selectedIds = selectedIdsOf(state);
  const pinnedItemIds = useMemo(() => timelinePinnedItemIds(
    selectedIds,
    [drag?.id, drag?.rightId, pointer.penDrag?.itemId, ctxMenu?.id, libDropTarget, pickDrag?.item?.id,
      ...((drag?.plannedState?.items ?? []).flatMap((next) => {
        const previous = indexes.itemById.get(next.id);
        return previous && (previous.startFrame !== next.startFrame || previous.durationInFrames !== next.durationInFrames
          || previous.track !== next.track || previous.srcInFrame !== next.srcInFrame) ? [next.id] : [];
      }))],
    state.transitions ?? [],
  ), [
    ctxMenu?.id, drag?.id, drag?.plannedState, drag?.rightId, indexes, libDropTarget, pickDrag?.item?.id,
    pointer.penDrag?.itemId, selectedIds, state.transitions,
  ]);

  return {
    state, commands, playerRef, onRecordVoiceover, onReviewItem, onDropExternalFiles,
    selectedCaptions, onSelectCaption, onMarqueeCaptionSelect,
    t, total, empty, trackIds, indexes, innerRef, scrollRef,
    relinkInputRef, trackInsertInputRef,
    hoverPreviewFrame, captionSelectionMovePreview, setCaptionSelectionMovePreview,
    commitTimelineSelectionMove, zoom, zoomMin, setZoom, px, trackScale, metaOf,
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, playing, editMode, placeMode, setPlaceMode, snapping, hoverPreviewEnabled, setHoverPreviewEnabled,
    captionsVisible, captionMenu, setCaptionMenu, trackMenu, setTrackMenu, transitionMenu, setTransitionMenu,
    duckMenu, setDuckMenu, captionError, setCaptionError,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu, recorder, toggleCaptions,
    pickMode, ctxMenu, setCtxMenu, fxClip, setFxClip, clipJob, setClipJob,
    beginRelink, relinkFile, beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    innerW, visibleWindow, rowHeightOf, tracksHeight,
    majorFrames, minorFrames, minorTicksPerMajor, rulerSpanFrames,
    frameFromClientX, trackFromClientY, copyCaptionSelections, pasteCaptionClipboard,
    pointer, drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel,
    cancelSeekGesture,
    activeSelectionMovePreview, libDropTarget, setLibDropTarget,
    applyLibraryToClip, applyLibraryToTrack, seekTo, seekFrame,
    clearHoverPreview, updateHoverPreview, startSeekGesture, updateSeekGesture, finishSeekGesture,
    markers, zoneIn, zoneOut, editing, editMarker, setEditMarker, pinnedItemIds,
  };
}
