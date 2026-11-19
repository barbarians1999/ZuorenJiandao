// Timeline shortcut API assembly (source shortcut-dispatcher): global dispatcher in Editor,Timeline every time
// Rendering rebuilds TimelineShortcutApi with latest closure into shortcutApiRef(effect no dependency array=forever
// Fresh, literally equivalent to the original Timeline inline writing method). I/O zone (zoneIn/Out), JKL shuttle machine, fragment
// The entire clipboard is owned by this hook; the fxClip clipboard is shared with the right-click menu and is passed in by Timeline.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import {
  selectedIdsOf, timelineTrackIds, trackKind,
  type TimelineState,
} from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import type { AtomicAction } from '../../editor/store';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { hasOperationalTranscript } from '../../transcript/types';
import { selectableItemIdsAtPlayheadSide } from '../../editor/multiSelect';
import { selectableCaptionSelectionsAtPlayheadSide, type CaptionSelectionRef } from '../../captions/captionSelection';
import { moveTimelineSelectionByDelta } from '../../captions/captionGroupMove';
import { createTimelineClipboardActions } from './timelineClipboardActions';
import { showAppToast } from '../../ui/appToast';
import type { FxClip } from './ClipContextMenu';
import type { TimelineShortcutApi, ItemClipboard } from '../../shortcuts/timelineApi';
import type { EditMode } from './timelineUtil';
import { setShuttlePlaybackRate, shuttleTick } from './shuttle';

export function shouldClearSelectionOnModeSwitch(
  currentMode: EditMode,
  targetMode: EditMode,
  selectedItemCount: number,
  selectedCaptionCount: number,
): boolean {
  if (targetMode !== 'selection') return false;
  if (currentMode === 'selection') return selectedItemCount > 0 || selectedCaptionCount > 0;
  return selectedItemCount > 1
    || selectedCaptionCount > 1
    || (selectedItemCount > 0 && selectedCaptionCount > 0);
}

interface ShortcutDeps {
  shortcutApiRef: RefObject<TimelineShortcutApi | null> | undefined;
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  playheadRef: RefObject<number>;
  total: number;
  seekFrame: (frame: number) => void;
  paintPlayhead: (frame: number, forceTc?: boolean) => void;
  editMode: EditMode;
  setEditMode: (m: EditMode) => void;
  selectedCaptions: CaptionSelectionRef[];
  setSnapping: (updater: (s: boolean) => boolean) => void;
  fitToView: () => void;
  zoomBy: (factor: number) => void;
  bladeSelected: () => void;
  setEditMarker: (id: string | null) => void;
  fxClip: FxClip | null;
  setFxClip: (fx: FxClip | null) => void;
  copySelectedCaptions: () => boolean;
  pasteCaptionClipboard: () => boolean;
  onSelectCaptionRange?: (
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => void;
}

export function useTimelineShortcuts(deps: ShortcutDeps): { zoneIn: number | null; zoneOut: number | null } {
  const {
    shortcutApiRef, state, commands, playerRef, playheadRef, total,
    seekFrame, paintPlayhead, editMode, setEditMode, selectedCaptions, setSnapping, fitToView, zoomBy,
    bladeSelected, setEditMarker, fxClip, setFxClip, copySelectedCaptions, pasteCaptionClipboard,
    onSelectCaptionRange,
  } = deps;

  // ── I/O marks + shuttle + clipboard ─────────────────────────────────────
  const [zoneIn, setZoneIn] = useState<number | null>(null);
  const [zoneOut, setZoneOut] = useState<number | null>(null);
  const itemClipRef = useRef<ItemClipboard>(null);
  const shuttleRateRef = useRef(0); // -4..+4 steps
  const shuttleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopShuttle = useCallback(() => {
    shuttleRateRef.current = 0;
    if (shuttleTimerRef.current) {
      clearInterval(shuttleTimerRef.current);
      shuttleTimerRef.current = null;
    }
    setShuttlePlaybackRate(1);
  }, []);
  const runShuttle = (dir: -1 | 0 | 1) => {
    if (dir === 0) {
      stopShuttle();
      playerRef.current?.pause();
      return;
    }
    if (dir === 1) {
      if (shuttleTimerRef.current) {
        clearInterval(shuttleTimerRef.current);
        shuttleTimerRef.current = null;
      }
      const cur = shuttleRateRef.current;
      let nextMag = 1;
      if (cur > 0) nextMag = Math.min(4, cur * 2);
      else if (cur === 0 && playerRef.current?.isPlaying?.()) nextMag = 2;
      shuttleRateRef.current = nextMag;
      setShuttlePlaybackRate(nextMag);
      if ((playerRef.current?.getCurrentFrame() ?? playheadRef.current) >= total - 1) {
        playerRef.current?.seekTo(0);
      }
      playerRef.current?.play();
      return;
    }
    setShuttlePlaybackRate(1);
    const cur = shuttleRateRef.current;
    const next = cur >= 0 ? -1 : Math.max(-4, cur - 1);
    shuttleRateRef.current = next;
    if (shuttleTimerRef.current) clearInterval(shuttleTimerRef.current);
    playerRef.current?.pause();
    const { stepFrames: step, intervalMs: ms } = shuttleTick(next);
    shuttleTimerRef.current = setInterval(() => {
      const curFrame = playheadRef.current;
      const nextFrame = Math.max(0, Math.min(total - 1, curFrame + step));
      playerRef.current?.seekTo(nextFrame);
      paintPlayhead(nextFrame, true);
      if (nextFrame <= 0 || nextFrame >= total - 1) stopShuttle();
    }, ms);
  };

  const gotoMarker = (dir: 1 | -1) => {
    const sorted = [...(state.markers ?? [])].filter((m) => m.scope === 'project').sort((a, b) => a.fromFrame - b.fromFrame);
    const next = dir === 1 ? sorted.find((m) => m.fromFrame > playheadRef.current) : [...sorted].reverse().find((m) => m.fromFrame < playheadRef.current);
    if (next) seekFrame(next.fromFrame);
  };

  // Expose shortcut API to Editor (single global dispatcher lives there)
  useEffect(() => {
    if (!shortcutApiRef) return;
    const api: TimelineShortcutApi = {
      ...createTimelineClipboardActions({
        state, commands, clipboard: itemClipRef, playhead: () => playheadRef.current,
        uid: (prefix) => `${prefix}_${crypto.randomUUID()}`,
        reportError: (error) => showAppToast(error, { error: true }),
        copySelectedCaptions, pasteCaptionClipboard,
      }),
      getPlayhead: () => playheadRef.current,
      seekTo: (frame) => seekFrame(frame),
      playPause: () => {
        stopShuttle();
        playerRef.current?.toggle();
      },
      isPlaying: () => {
        try { return !!playerRef.current?.isPlaying?.(); } catch { return false; }
      },
      setEditMode: (m) => {
        const selectedItemIds = selectedIdsOf(state);
        if (shouldClearSelectionOnModeSwitch(editMode, m, selectedItemIds.length, selectedCaptions.length)) {
          if (selectedItemIds.length > 0) commands.selectItems([]);
          if (selectedCaptions.length > 0) {
            onSelectCaptionRange?.([], { additive: false, preserveWithItems: false });
          }
        }
        setEditMode(m);
      },
      toggleSnap: () => setSnapping((s) => !s),
      fitToView: () => fitToView(),
      zoomBy: (f) => zoomBy(f),
      splitAtPlayhead: () => bladeSelected(),
      nudgeSelected: (delta) => {
        const ids = selectedIdsOf(state);
        if (selectedCaptions.length > 0) {
          const next = moveTimelineSelectionByDelta(state, ids, selectedCaptions, delta);
          if (next !== state) commands.applyState(next);
          return;
        }
        const actions: AtomicAction[] = [];
        for (const id of ids) {
          const it = state.items.find((x) => x.id === id);
          if (!it || state.tracks?.[it.track]?.locked) continue;
          actions.push({ type: 'move' as const, id, startFrame: Math.max(0, it.startFrame + delta) });
        }
        commands.batch(actions, '微移所选片段');
      },
      trimSelectedToPlayhead: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ph = playheadRef.current;
        if (side === 'start') {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          const delta = ph - it.startFrame;
          const timing: { startFrame: number; durationInFrames: number; srcInFrame?: number } = {
            startFrame: ph,
            durationInFrames: it.durationInFrames - delta,
          };
          // Advance source in-point so the visible media stays aligned (split semantics).
          if (it.kind === 'video' || it.kind === 'audio') {
            timing.srcInFrame = sourceWindowForTimelineRange(
              it.kind === 'audio' && hasOperationalTranscript(it) ? { ...it, playbackRate: 1 } : it,
              delta,
              timing.durationInFrames,
            ).startFrame;
          }
          commands.setItemTiming(id, timing);
        } else {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          commands.setItemTiming(id, { durationInFrames: Math.max(1, ph - it.startFrame) });
        }
      },
      selectBeforePlayhead: () => {
        const ph = playheadRef.current;
        const itemIds = selectableItemIdsAtPlayheadSide(state, ph, 'before');
        const captionSelections = selectableCaptionSelectionsAtPlayheadSide(state, ph, 'before');
        onSelectCaptionRange?.(captionSelections, {
          additive: false,
          preserveWithItems: itemIds.length > 0 && captionSelections.length > 0,
        });
        commands.selectItems(itemIds);
      },
      selectAllAfterPlayhead: () => {
        const ph = playheadRef.current;
        const itemIds = selectableItemIdsAtPlayheadSide(state, ph, 'after');
        const captionSelections = selectableCaptionSelectionsAtPlayheadSide(state, ph, 'after');
        onSelectCaptionRange?.(captionSelections, {
          additive: false,
          preserveWithItems: itemIds.length > 0 && captionSelections.length > 0,
        });
        commands.selectItems(itemIds);
      },
      selectAfterPlayhead: () => {
        const ph = playheadRef.current;
        const next = [...state.items]
          .filter((it) => it.startFrame >= ph)
          .sort((a, b) => a.startFrame - b.startFrame)[0]
          ?? [...state.items].filter((it) => it.startFrame + it.durationInFrames > ph).sort((a, b) => a.startFrame - b.startFrame)[0];
        if (next) commands.selectItem(next.id);
      },
      selectUnderPlayhead: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames);
        commands.selectItem(hit?.id ?? state.items[0]?.id ?? null);
      },
      gotoEdit: (dir) => {
        const ph = playheadRef.current;
        const cuts = new Set<number>([0, total]);
        for (const it of state.items) {
          cuts.add(it.startFrame);
          cuts.add(it.startFrame + it.durationInFrames);
        }
        const sorted = [...cuts].sort((a, b) => a - b);
        if (dir === 1) {
          const n = sorted.find((f) => f > ph + 0.5);
          if (n != null) seekFrame(n);
        } else {
          const n = [...sorted].reverse().find((f) => f < ph - 0.5);
          if (n != null) seekFrame(n);
        }
      },
      gotoMarker: (dir) => gotoMarker(dir),
      addMarker: (open) => {
        const id = commands.addMarker(playheadRef.current);
        if (open) setEditMarker(id);
      },
      modifyMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) setEditMarker(m.id);
        else {
          const id = commands.addMarker(ph);
          setEditMarker(id);
        }
      },
      deleteMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) commands.removeMarker(m.id);
      },
      setZoneIn: () => setZoneIn(playheadRef.current),
      setZoneOut: () => setZoneOut(playheadRef.current),
      clearZone: () => { setZoneIn(null); setZoneOut(null); },
      zoneFromClip: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames)
          ?? state.items.find((it) => it.id === state.selectedId);
        if (hit) {
          setZoneIn(hit.startFrame);
          setZoneOut(hit.startFrame + hit.durationInFrames);
        }
      },
      zoneFromSelection: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (it) {
          setZoneIn(it.startFrame);
          setZoneOut(it.startFrame + it.durationInFrames);
        }
      },
      getZone: () => ({ inFrame: zoneIn, outFrame: zoneOut }),
      shuttle: (dir) => {
        runShuttle(dir);
      },
      shuttleJog: (dir) => {
        stopShuttle();
        seekFrame(playheadRef.current + dir);
      },
      moveSelectedTrack: (dir) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ids = timelineTrackIds(state);
        const idx = ids.indexOf(it.track);
        if (idx < 0) return;
        const ni = idx + dir;
        if (ni < 0 || ni >= ids.length) return;
        const dest = ids[ni]!;
        if (trackKind(state, dest) !== trackKind(state, it.track)) return;
        commands.moveItem(id, { track: dest, startFrame: it.startFrame });
      },
      moveSelectedToBoundary: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const same = state.items.filter((x) => x.track === it.track && x.id !== id);
        if (side === 'left') {
          const left = same.filter((x) => x.startFrame + x.durationInFrames <= it.startFrame)
            .sort((a, b) => (b.startFrame + b.durationInFrames) - (a.startFrame + a.durationInFrames))[0];
          const target = left ? left.startFrame + left.durationInFrames : 0;
          commands.moveItem(id, { startFrame: target });
        } else {
          const right = same.filter((x) => x.startFrame >= it.startFrame + it.durationInFrames)
            .sort((a, b) => a.startFrame - b.startFrame)[0];
          const target = right ? right.startFrame - it.durationInFrames : it.startFrame;
          commands.moveItem(id, { startFrame: Math.max(0, target) });
        }
      },
      pasteEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || !fxClip || it.kind === 'audio') return;
        const actions: AtomicAction[] = [
          ...(fxClip.filters ? [{ type: 'setFilters' as const, id: it.id, patch: fxClip.filters }] : []),
          ...(fxClip.transform ? [{ type: 'setTransform' as const, id: it.id, patch: fxClip.transform }] : []),
          { type: 'setZoom' as const, id: it.id, patch: fxClip.zoom ?? null },
          {
            type: 'setFade' as const,
            id: it.id,
            fadeInFrames: fxClip.fadeInFrames ?? 0,
            fadeOutFrames: fxClip.fadeOutFrames ?? 0,
          },
        ];
        commands.batch(actions, '粘贴片段效果');
      },
      copyEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || it.kind === 'audio') return;
        setFxClip({
          filters: it.filters,
          transform: it.transform,
          zoom: it.zoom,
          fadeInFrames: it.fadeInFrames,
          fadeOutFrames: it.fadeOutFrames,
        });
      },
      fullscreenPreview: () => {
        const player = playerRef.current;
        if (!player) return;
        if (player.isFullscreen()) player.exitFullscreen();
        else player.requestFullscreen();
      },
      getFxClip: () => fxClip,
      setFxClip: (fx) => setFxClip(fx),
    };
    shortcutApiRef.current = api;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep API fresh each render
  });
  useEffect(() => () => {
    if (shortcutApiRef) shortcutApiRef.current = null;
    stopShuttle();
  }, [shortcutApiRef, stopShuttle]);

  return { zoneIn, zoneOut };
}
