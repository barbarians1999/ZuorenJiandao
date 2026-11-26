import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { buildCues, type CueRow } from './captionCues';
import { hasCaptionCueEndedAt, hasCaptionCueStartedAt } from './captionPages';
import type { CaptionSelectOptions, CaptionSelectionRef } from './captionSelection';
import { appendCaptionCueAfter, captionListId, captionListPatch, captionListRange, captionListSelection, captionReplaceEdits, selectedCaptionListIds } from './captionList';
import { planCaptionCueEdit } from './captionCueEditing';
import { captionCueKeyboardIntent } from './captionCueEditingKeyboard';
import { captionDataSignature, planPendingCaptionRecovery, readCaptionDraftRecovery, writeCaptionDraftRecovery, type CaptionCueDraftRecoveryValue, type PendingCaptionDraftRecovery } from './captionDraftRecovery';
import './caption-list.css';

const BASE_ROW_HEIGHT = 72;
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function estimateCueRowHeight(row: CueRow, editing: boolean): number {
  const lines = Math.max(row.text.split('\n').length, Math.ceil(Math.max(1, row.text.length) / 14));
  const extra = lines > 1 ? (lines - 1) * 22 : 0;
  return Math.max(BASE_ROW_HEIGHT, 48 + extra + (editing ? 28 : 0));
}

function firstIndexForOffset(offsets: readonly number[], scrollTop: number): number {
  let lo = 0;
  let hi = Math.max(0, offsets.length - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface CaptionCueEditorProps {
  projectId?: string;
  timelineId?: string;
  captionTrackId?: string;
  draftKey?: string;
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  reviewRequest?: { ms: number; serial: number };
  playheadMs?: number;
  playing?: boolean;
  selectedCaptions?: readonly CaptionSelectionRef[];
  captionActivationRequest?: { selection: CaptionSelectionRef; nonce: number };
  onCaptionActivationConsumed?: (nonce: number) => void;
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onSelectCaptionRange?: (selections: CaptionSelectionRef[], options: { additive: boolean; preserveWithItems: boolean }) => void;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  onLiveUpdate?: (patch: Partial<CaptionsData> | null) => void;
  onSeekMs?: (ms: number) => void;
}
interface Draft extends CaptionCueDraftRecoveryValue {}

export function CaptionCueEditor({ projectId = '', timelineId = '', captionTrackId = '', draftKey, captions, items, fps, reviewRequest, playheadMs = 0, playing = false,
  selectedCaptions, captionActivationRequest, onCaptionActivationConsumed, onSelectCaption, onSelectCaptionRange, onUpdate, onLiveUpdate, onSeekMs }: CaptionCueEditorProps) {
  const t = useT();
  const rows = useMemo(() => buildCues(captions, items, fps), [captions, items, fps]);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [localSelection, setLocalSelection] = useState<string[]>([]);
  const draftStorageKey = draftKey && captionTrackId ? `cc-caption-inline:${draftKey}:${captionTrackId}` : null;
  const initialRecovery = draftStorageKey ? readCaptionDraftRecovery(draftStorageKey) : { draft: null, pending: [] };
  const [draft, setDraft] = useState<Draft | null>(() => initialRecovery.draft);
  const [pendingRecovery, setPendingRecovery] = useState<PendingCaptionDraftRecovery[]>(initialRecovery.pending);
  const recoveryRef = useRef(initialRecovery);
  const draftRef = useRef<Draft | null>(draft);
  draftRef.current = draft;
  const draftStorageKeyRef = useRef(draftStorageKey);
  draftStorageKeyRef.current = draftStorageKey;
  const onLiveUpdateRef = useRef(onLiveUpdate);
  onLiveUpdateRef.current = onLiveUpdate;
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyPersistRef = useRef(false);
  const liveUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingPersist = () => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  };
  const flushPendingPersist = () => {
    cancelPendingPersist();
    if (!dirtyPersistRef.current) return;
    dirtyPersistRef.current = false;
    if (draftStorageKeyRef.current) {
      writeCaptionDraftRecovery(draftStorageKeyRef.current, recoveryRef.current);
    }
  };
  const cancelPendingLiveUpdate = () => {
    if (liveUpdateTimerRef.current) {
      clearTimeout(liveUpdateTimerRef.current);
      liveUpdateTimerRef.current = null;
    }
  };
  useEffect(() => {
    window.addEventListener('beforeunload', flushPendingPersist);
    window.addEventListener('pagehide', flushPendingPersist);
    return () => {
      window.removeEventListener('beforeunload', flushPendingPersist);
      window.removeEventListener('pagehide', flushPendingPersist);
      cancelPendingLiveUpdate();
      onLiveUpdateRef.current?.(null);
      flushPendingPersist();
    };
  }, []);
  const [notice, setNotice] = useState(draft ? t('已恢复上次未保存的字幕草稿，请确认后保存或取消。') : '');
  const persistRecovery = (nextDraft: Draft | null, nextPending = recoveryRef.current.pending): boolean => {
    cancelPendingPersist();
    dirtyPersistRef.current = false;
    if (draftStorageKey && !writeCaptionDraftRecovery(draftStorageKey, { draft: nextDraft, pending: nextPending })) {
      setDraft(nextDraft); draftRef.current = nextDraft;
      setNotice(t('无法保存恢复草稿；字幕文字仍保留在当前编辑中。'));
      return false;
    }
    recoveryRef.current = { draft: nextDraft, pending: nextPending };
    setPendingRecovery(nextPending);
    setDraft(nextDraft); draftRef.current = nextDraft;
    return true;
  };
  const updateDraft = (next: Draft | null) => { persistRecovery(next); };
  const updateDraftTyping = (next: Draft) => {
    recoveryRef.current = { draft: next, pending: recoveryRef.current.pending };
    setDraft(next);
    draftRef.current = next;
    if (!draftStorageKey) return;
    dirtyPersistRef.current = true;
    cancelPendingPersist();
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (!dirtyPersistRef.current) return;
      dirtyPersistRef.current = false;
      if (draftStorageKey && !writeCaptionDraftRecovery(draftStorageKey, recoveryRef.current)) {
        setNotice(t('无法保存恢复草稿；字幕文字仍保留在当前编辑中。'));
      }
    }, 300);
  };
  const storePendingRecovery = (source: Draft, patch: Partial<CaptionsData>): boolean => {
    const target = { ...captions, ...patch };
    const entry: PendingCaptionDraftRecovery = { timelineId, trackId: captionTrackId,
      baseSignature: captionDataSignature(captions), targetSignature: captionDataSignature(target), draft: source, patch };
    if (persistRecovery(null, [...recoveryRef.current.pending, entry])) return true;
    setDraft(source); draftRef.current = source;
    return false;
  };
  const [scrollTop, setScrollTop] = useState(0);
  const [follow, setFollow] = useState(() => { try { return localStorage.getItem('cc.caption.list.follow') !== '0'; } catch { return true; } });
  const listRef = useRef<HTMLDivElement>(null);
  const dragScrollLockRef = useRef<number | null>(null);
  const pointerDownInListRef = useRef(false);
  const pointerReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressCenterIdRef = useRef<string | null>(null);
  const pendingCenterRef = useRef<string | null>(null);
  const centerTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const release = () => {
      dragScrollLockRef.current = null;
      if (pointerReleaseTimerRef.current) clearTimeout(pointerReleaseTimerRef.current);
      pointerReleaseTimerRef.current = setTimeout(() => {
        pointerReleaseTimerRef.current = null;
        pointerDownInListRef.current = false;
      }, 0);
    };
    const releaseNow = () => {
      dragScrollLockRef.current = null;
      if (pointerReleaseTimerRef.current) {
        clearTimeout(pointerReleaseTimerRef.current);
        pointerReleaseTimerRef.current = null;
      }
      pointerDownInListRef.current = false;
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', releaseNow, true);
    window.addEventListener('blur', releaseNow);
    return () => {
      if (pointerReleaseTimerRef.current) clearTimeout(pointerReleaseTimerRef.current);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', releaseNow, true);
      window.removeEventListener('blur', releaseNow);
    };
  }, []);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const confirming = useRef(false);
  const pendingFocus = useRef<{ id: string; caret: number; selectAll?: boolean } | null>(null);
  const commitFailed = useRef(false);
  const committedDraft = useRef<string | null>(null);
  const anchor = useRef<string | null>(null);
  const lastReviewSerial = useRef<number | undefined>(undefined);
  const revealedSelection = useRef<string | null>(null);
  const lastActivationNonce = useRef(0);
  const activationPriority = useRef<number | null>(null);
  const [pendingActivationReveal, setPendingActivationReveal] = useState<{ id: string; nonce: number } | null>(null);
  const lastPickSeekRef = useRef<{ id: string; at: number } | null>(null);
  const visible = useMemo(() => rows.filter((row) => !query || row.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [rows, query]);
  const replacementEdits = useMemo(() => captionReplaceEdits(rows, query, replacement), [rows, query, replacement]);
  const rowIndexById = useMemo(() => new Map(rows.map((row, index) => [captionListId(row), index])), [rows]);
  const selected = useMemo(
    () => (selectedCaptions && captions.enabled ? selectedCaptionListIds(captionTrackId, rows, selectedCaptions) : localSelection),
    [selectedCaptions, captions.enabled, captionTrackId, rows, localSelection],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const editRow = draft ? rows[rowIndexById.get(draft.id) ?? -1] : undefined;
  const activeId = useMemo(() => {
    if (!rows.length) return null;
    const upperBoundMs = playheadMs + Math.ceil(2000 / Math.max(1, fps)) + 100;
    let lo = 0;
    let hi = rows.length - 1;
    let rightmost = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.start <= upperBoundMs) {
        rightmost = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = rightmost; i >= 0; i -= 1) {
      const row = rows[i]!;
      const prev = i > 0 ? rows[i - 1] : undefined;
      if (!hasCaptionCueStartedAt(row.start, playheadMs, fps, prev?.end)) continue;
      if (!hasCaptionCueEndedAt(row.start, row.end, playheadMs, fps)) {
        return captionListId(row);
      }
    }
    return null;
  }, [rows, playheadMs, fps]);
  const lastSelectedId = selected.at(-1) ?? null;
  const latestRef = useRef({ captions, items, fps, rows, rowIndexById });
  latestRef.current = { captions, items, fps, rows, rowIndexById };
  const scheduleLiveUpdate = (nextDraft: Draft) => {
    if (!onLiveUpdateRef.current) return;
    cancelPendingLiveUpdate();
    liveUpdateTimerRef.current = setTimeout(() => {
      liveUpdateTimerRef.current = null;
      const handler = onLiveUpdateRef.current;
      if (!handler) return;
      const current = latestRef.current;
      const rowIndex = current.rowIndexById.get(nextDraft.id);
      if (rowIndex === undefined) return;
      const currentRow = current.rows[rowIndex];
      if (!currentRow) return;
      const timing: { start?: number; end?: number } = currentRow.manual ? { start: currentRow.start, end: currentRow.end } : {};
      const safeText = nextDraft.text || ' ';
      const planned = planCaptionCueEdit({
        captions: current.captions, items: current.items, fps: current.fps, rows: current.rows,
        rowIndex, action: 'save', text: safeText,
        manualTiming: currentRow.manual ? { startMs: currentRow.start, endMs: currentRow.end } : undefined,
      });
      handler(planned.patch ?? captionListPatch(current.captions, current.items, current.fps, [{ id: nextDraft.id, text: safeText, ...timing }]));
    }, 120);
  };
  const measuredHeightsRef = useRef<Record<string, number>>({});
  const rowNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  const { offsets, totalHeight } = useMemo(() => {
    const nextOffsets = new Array<number>(visible.length + 1);
    nextOffsets[0] = 0;
    for (let i = 0; i < visible.length; i += 1) {
      const row = visible[i]!;
      const id = captionListId(row);
      const editingThis = draft?.id === id;
      const measured = !editingThis ? measuredHeightsRef.current[id] : undefined;
      const height = measured ?? estimateCueRowHeight(row, editingThis);
      nextOffsets[i + 1] = nextOffsets[i]! + height;
    }
    return { offsets: nextOffsets, totalHeight: nextOffsets[visible.length] ?? 0 };
  }, [visible, draft?.id, measureTick]);

  const measureMountedHeights = (): boolean => {
    let changed = false;
    rowNodesRef.current.forEach((node, id) => {
      if (draftRef.current?.id === id) return;
      const measured = Math.ceil(node.getBoundingClientRect().height);
      if (measured > 0 && measuredHeightsRef.current[id] !== measured) {
        measuredHeightsRef.current[id] = measured;
        changed = true;
      }
    });
    return changed;
  };

  const observerRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const syncHeights = () => {
      raf = 0;
      if (measureMountedHeights()) setMeasureTick((v) => v + 1);
    };
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(syncHeights);
    });
    observerRef.current = ro;
    rowNodesRef.current.forEach((node) => ro.observe(node));
    syncHeights();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      if (observerRef.current === ro) observerRef.current = null;
    };
  }, [visible, draft?.id]);

  const reveal = (id: string, options?: { center?: boolean }) => {
    const index = visible.findIndex((row) => captionListId(row) === id);
    const element = listRef.current;
    if (index < 0 || !element || element.clientHeight <= 0) return;
    const domNode = rowNodesRef.current.get(id);
    const top = domNode ? domNode.offsetTop : (offsets[index] ?? index * BASE_ROW_HEIGHT);
    const rowHeight = domNode ? domNode.offsetHeight : ((offsets[index + 1] ?? top + BASE_ROW_HEIGHT) - top);
    let nextScrollTop = element.scrollTop;
    if (options?.center) {
      nextScrollTop = top + rowHeight / 2 - element.clientHeight / 2;
      pendingCenterRef.current = domNode ? null : id;
      centerTargetRef.current = id;
    } else {
      pendingCenterRef.current = null;
      centerTargetRef.current = null;
      const bottom = top + rowHeight;
      if (top < nextScrollTop) nextScrollTop = top;
      else if (bottom > nextScrollTop + element.clientHeight) nextScrollTop = bottom - element.clientHeight;
    }
    dragScrollLockRef.current = null;
    element.scrollTop = Math.max(0, Math.min(Math.max(0, element.scrollHeight - element.clientHeight), nextScrollTop));
    setScrollTop(element.scrollTop);
  };
  useClientLayoutEffect(() => {
    const targetId = pendingCenterRef.current ?? centerTargetRef.current;
    if (!targetId) return;
    const element = listRef.current;
    if (!element || element.clientHeight <= 0) return;
    if (measureMountedHeights()) {
      setMeasureTick((v) => v + 1);
      return;
    }
    const domNode = rowNodesRef.current.get(targetId);
    if (!domNode) {
      if (pendingCenterRef.current === targetId) reveal(targetId, { center: true });
      return;
    }
    pendingCenterRef.current = null;
    const nextScrollTop = domNode.offsetTop + domNode.offsetHeight / 2 - element.clientHeight / 2;
    const clamped = Math.max(0, Math.min(Math.max(0, element.scrollHeight - element.clientHeight), nextScrollTop));
    if (Math.abs(element.scrollTop - clamped) > 1) {
      dragScrollLockRef.current = null;
      element.scrollTop = clamped;
      setScrollTop(element.scrollTop);
    } else {
      centerTargetRef.current = null;
    }
  }, [scrollTop, visible, measureTick]);
  useClientLayoutEffect(() => {
    const request = captionActivationRequest;
    if (!request || request.nonce === lastActivationNonce.current || request.selection.trackId !== captionTrackId) return;
    const targetId = selectedCaptionListIds(captionTrackId, rows, [request.selection]).at(-1);
    if (!targetId) return;
    activationPriority.current = request.nonce;
    if (query && !visible.some((row) => captionListId(row) === targetId)) { setQuery(''); return; }
    const list = listRef.current;
    const target = list && [...list.querySelectorAll<HTMLElement>('[data-cue-id]')]
      .find((node) => node.getAttribute('data-cue-id') === targetId);
    if (!target) {
      if (pendingActivationReveal?.nonce !== request.nonce) setPendingActivationReveal({ id: targetId, nonce: request.nonce });
      reveal(targetId, { center: true });
      return;
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    setScrollTop(list!.scrollTop);
    lastActivationNonce.current = request.nonce;
    revealedSelection.current = targetId;
    setPendingActivationReveal(null);
    onCaptionActivationConsumed?.(request.nonce);
  }, [captionActivationRequest?.nonce, captionTrackId, rows, query, visible, pendingActivationReveal, scrollTop]);
  useEffect(() => {
    if (activationPriority.current !== null) return;
    if (revealedSelection.current === lastSelectedId) return;
    if (!lastSelectedId) { revealedSelection.current = null; return; }
    if (query && !visible.some((row) => captionListId(row) === lastSelectedId)) { setQuery(''); return; }
    revealedSelection.current = lastSelectedId;
    reveal(lastSelectedId, { center: suppressCenterIdRef.current !== lastSelectedId });
  }, [lastSelectedId, query, visible]);
  const wasPlayingRef = useRef(playing);
  useEffect(() => {
    const startedPlaying = playing && !wasPlayingRef.current;
    wasPlayingRef.current = playing;
    if (playing) activationPriority.current = null;
    if (activationPriority.current !== null) return;
    if (!follow || !activeId) return;
    let editorFocused = typeof document !== 'undefined' && document.activeElement === editorRef.current;
    if (playing) {
      suppressCenterIdRef.current = null;
      if (startedPlaying && editorFocused) {
        if (draft && draft.text === draft.baseText) updateDraft(null);
        editorRef.current?.blur();
        editorFocused = false;
      } else if (draft && !editorFocused && draft.text === draft.baseText) {
        updateDraft(null);
      }
      if (!editorFocused) reveal(activeId, { center: true });
      return;
    }
    if (pointerDownInListRef.current) return;
    if (!draft) {
      if (suppressCenterIdRef.current === activeId) {
        suppressCenterIdRef.current = null;
        return;
      }
      suppressCenterIdRef.current = null;
      reveal(activeId, { center: true });
    } else if (startedPlaying) {
      suppressCenterIdRef.current = null;
      reveal(activeId, { center: true });
    }
  }, [activeId, follow, draft, visible, playing]);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let wasHidden = el.clientHeight <= 0;
    const ro = new ResizeObserver(() => {
      const visibleNow = el.clientHeight > 0;
      if (wasHidden && visibleNow && follow && activeId && (playing || !draftRef.current)) {
        reveal(activeId, { center: true });
      }
      wasHidden = !visibleNow;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [follow, activeId, playing]);
  useEffect(() => {
    if (activationPriority.current !== null && captionActivationRequest?.nonce !== activationPriority.current) activationPriority.current = null;
  }, [captionActivationRequest?.nonce]);
  useEffect(() => {
    if (!projectId) return;
    const syncSavedPendingDrafts = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; changedKeys?: string[] }>).detail;
      if (detail?.projectId !== projectId || !draftStorageKey || !detail.changedKeys?.includes(draftStorageKey)) return;
      const saved = readCaptionDraftRecovery(draftStorageKey);
      const hadPending = recoveryRef.current.pending.length > 0;
      persistRecovery(draftRef.current, saved.pending);
      if (hadPending && !saved.pending.length && !draftRef.current) setNotice(t('字幕修改已保存。'));
    };
    window.addEventListener('cc-caption-drafts-saved', syncSavedPendingDrafts);
    return () => window.removeEventListener('cc-caption-drafts-saved', syncSavedPendingDrafts);
  }, [projectId, draftStorageKey, t]);
  useEffect(() => {
    if (!draft) return;
    if (!editRow) {
      if (draft.text === draft.baseText) {
        commitFailed.current = false;
        updateDraft(null);
        setNotice('');
      } else {
        setNotice(t('这句字幕已被删除或重新分组，请先复制或取消编辑中的文字。'));
      }
      return;
    }
    const timeChanged = editRow.start !== draft.baseStart || editRow.end !== draft.baseEnd;
    if (draft.text === draft.baseText) {
      if (editRow.text !== draft.baseText || timeChanged) {
        commitFailed.current = false;
        updateDraft({
          id: draft.id, baseText: editRow.text, baseStart: editRow.start, baseEnd: editRow.end,
          text: editRow.text, start: String(editRow.start / 1000), end: String(editRow.end / 1000),
        });
        setNotice('');
      }
      return;
    }
    if (editRow.text !== draft.baseText) {
      setNotice(t('字幕文字已从时间线更新；当前未保存的文字仍保留，可继续修改或取消编辑。'));
      return;
    }
    if (timeChanged) {
      commitFailed.current = false;
      updateDraft({
        ...draft, baseStart: editRow.start, baseEnd: editRow.end,
        start: String(editRow.start / 1000), end: String(editRow.end / 1000),
      });
      setNotice('');
    }
  }, [editRow, draft, t]);

  const pick = (row: CueRow, event?: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    const id = captionListId(row);
    suppressCenterIdRef.current = id;
    const additive = !!(event?.ctrlKey || event?.metaKey);
    if (event?.shiftKey) {
      const range = captionListRange(visible, anchor.current, id);
      const next = additive ? [...new Set([...selected, ...range])] : range;
      setLocalSelection(next);
      const selections = rows.filter((candidate) => next.includes(captionListId(candidate))).flatMap((candidate) => {
        const selection = captionListSelection(captionTrackId, candidate); return selection ? [selection] : [];
      });
      onSelectCaptionRange?.(selections, { additive: false, preserveWithItems: false });
    } else {
      setLocalSelection(additive ? selectedSet.has(id) ? selected.filter((entry) => entry !== id) : [...selected, id] : [id]);
      const selection = captionListSelection(captionTrackId, row);
      if (selection) onSelectCaption?.(selection, { additive, toggle: additive });
      anchor.current = id;
    }
    lastPickSeekRef.current = { id, at: performance.now() };
    onSeekMs?.(row.start);
  };
  const edit = (row: CueRow) => {
    if (draft && draft.id !== captionListId(row) && committedDraft.current !== draft.id) {
      if (!editRow || draft.text === draft.baseText) commitFailed.current = false;
      else if (!commit()) return;
    }
    commitFailed.current = false;
    committedDraft.current = null;
    pick(row);
    updateDraft({ id: captionListId(row), baseText: row.text, baseStart: row.start, baseEnd: row.end,
      text: row.text, start: String(row.start / 1000), end: String(row.end / 1000) });
    setNotice('');
  };
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const row = rows.find((candidate) =>
      captionListId(candidate) === pending.id || candidate.entry?.words?.[candidate.manualIndex ?? -1]?.id === pending.id
    );
    if (!row) return;
    const id = captionListId(row);
    pendingFocus.current = null;
    pick(row);
    updateDraft({ id, baseText: row.text, baseStart: row.start, baseEnd: row.end,
      text: row.text, start: String(row.start / 1000), end: String(row.end / 1000) });
    reveal(id, { center: true });
    requestAnimationFrame(() => {
      if (typeof document !== 'undefined' && document.activeElement?.closest('[data-cc-shortcut-surface="timeline"]')) return;
      editorRef.current?.focus();
      if (pending.selectAll) editorRef.current?.select();
      else editorRef.current?.setSelectionRange(pending.caret, pending.caret);
    });
  }, [rows]);
  const lastOpenedDraftIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = draft?.id ?? null;
    const prevId = lastOpenedDraftIdRef.current;
    lastOpenedDraftIdRef.current = nextId;
    if (!nextId || nextId === prevId || pendingFocus.current) return;
    if (typeof document !== 'undefined' && document.activeElement?.closest('[data-cc-shortcut-surface="timeline"]')) return;
    const el = editorRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  }, [draft?.id]);
  useEffect(() => {
    if (!reviewRequest || lastReviewSerial.current === reviewRequest.serial) return;
    const row = rows.find((candidate) => Math.abs(candidate.start - reviewRequest.ms) < 1);
    if (!row) return;
    lastReviewSerial.current = reviewRequest.serial;
    edit(row);
    reveal(captionListId(row), { center: true });
  }, [reviewRequest, rows]);

  const commit = (fromBlur = false) => {
    if (!draft) return false;
    if (!editRow) {
      if (fromBlur || draft.text === draft.baseText) { commitFailed.current = false; suppressCenterIdRef.current = null; updateDraft(null); setNotice(''); return true; }
      commitFailed.current = true;
      setNotice(t('这句字幕已被删除或重新分组，请先复制或取消编辑中的文字。'));
      return false;
    }
    if (draft.text === draft.baseText) {
      commitFailed.current = false;
      committedDraft.current = draft.id;
      suppressCenterIdRef.current = null;
      updateDraft(null);
      setNotice('');
      return true;
    }
    if (!draft.text.trim()) {
      if (fromBlur) {
        commitFailed.current = false;
        suppressCenterIdRef.current = null;
        cancelPendingLiveUpdate();
        updateDraft(null);
        onLiveUpdate?.(null);
        setNotice(t('字幕内容不能为空，已恢复原文字；如需删除请点击右侧删除图标。'));
        return true;
      }
      commitFailed.current = true;
      setNotice(t('字幕内容不能为空；如需删除，请点击右侧删除图标。'));
      return false;
    }
    const syncedDraft: Draft = {
      ...draft, baseText: editRow.text, baseStart: editRow.start, baseEnd: editRow.end,
      start: String(editRow.start / 1000), end: String(editRow.end / 1000),
    };
    const timing: { start?: number; end?: number } = editRow.manual ? { start: editRow.start, end: editRow.end } : {};
    const planned = planCaptionCueEdit({ captions, items, fps, rows, rowIndex: rows.indexOf(editRow), action: 'save',
      text: syncedDraft.text, manualTiming: editRow.manual ? { startMs: editRow.start, endMs: editRow.end } : undefined });
    const patch = planned.patch ?? captionListPatch(captions, items, fps, [{ id: syncedDraft.id, text: syncedDraft.text, ...timing }]);
    if (!patch) { commitFailed.current = true; setNotice(planned.reason ?? t('无法保存字幕，文字仍保留。')); return false; }
    if (!storePendingRecovery(syncedDraft, patch)) return false;
    suppressCenterIdRef.current = null;
    if (patch) {
      cancelPendingLiveUpdate();
      onLiveUpdate?.(null);
      onUpdate(patch);
      const updatedRows = buildCues({ ...captions, ...patch }, items, fps);
      const next = updatedRows.find((row) => captionListId(row) === syncedDraft.id) ?? updatedRows[rows.indexOf(editRow)];
      const selection = next ? captionListSelection(captionTrackId, next) : null;
      onSelectCaption?.(selection);
    }
    commitFailed.current = false;
    committedDraft.current = syncedDraft.id;
    setNotice('');
    return true;
  };
  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); commitFailed.current = false; suppressCenterIdRef.current = null; cancelPendingLiveUpdate(); onLiveUpdate?.(null); updateDraft(null); return; }
    const intent = captionCueKeyboardIntent({
      key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode,
      selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd,
      textLength: event.currentTarget.value.length,
    });
    if (intent === 'native') return;
    event.preventDefault();
    if (intent === 'selection') { setNotice(t('请先取消文字选区，再将光标放在拆分位置。')); return; }
    if (intent === 'save') { commit(); return; }
    if (!draft || !editRow) return;
    const request = { captions, items, fps, rows, rowIndex: rows.indexOf(editRow), action: intent,
      text: draft.text, caret: event.currentTarget.selectionStart ?? 0,
      manualTiming: editRow.manual ? { startMs: editRow.start, endMs: editRow.end } : undefined };
    const result = planCaptionCueEdit({ ...request, acceptMergeConflict: true });
    if (!result.patch) { setNotice(result.reason ?? t('无法编辑这句字幕。')); return; }
    if (!storePendingRecovery(draft, result.patch)) return;
    const nextRows = buildCues({ ...captions, ...result.patch }, items, fps);
    const targetIndex = intent === 'mergePrevious' ? request.rowIndex - 1 : intent === 'split' ? request.rowIndex + 1 : request.rowIndex;
    const target = result.focus ? nextRows.find((row) => result.focus?.displayPartId
      ? row.displayCuePartId === result.focus.displayPartId
      : row.entry?.words?.[row.manualIndex ?? -1]?.id === result.focus?.manualCueId) : nextRows[targetIndex];
    if (target) pendingFocus.current = { id: captionListId(target), caret: result.focus?.caret ?? (intent === 'split' ? 0 :
      intent === 'mergePrevious' ? rows[request.rowIndex - 1]!.text.trimEnd().length : draft.text.trimEnd().length) };
    cancelPendingLiveUpdate();
    onLiveUpdate?.(null);
    onUpdate(result.patch); setNotice('');
  };
  const removeSelected = () => {
    cancelPendingLiveUpdate();
    onLiveUpdate?.(null);
    const patch = captionListPatch(captions, items, fps, selected.map((id) => ({ id, text: null })));
    if (patch) onUpdate(patch);
    updateDraft(null); setLocalSelection([]); onSelectCaption?.(null);
  };
  const addAfter = (row: CueRow) => {
    const id = captionListId(row);
    const added = appendCaptionCueAfter(captions, items, fps, id, t('新字幕'));
    if (!added) return;
    cancelPendingLiveUpdate();
    onLiveUpdate?.(null);
    if (draft) {
      confirming.current = true;
      updateDraft(null);
      queueMicrotask(() => { confirming.current = false; });
    }
    pendingFocus.current = { id: added.cueId, caret: 0, selectAll: true };
    onUpdate(added.patch);
    setNotice(t('已新增字幕。'));
  };
  const removeRow = (row: CueRow) => {
    const id = captionListId(row);
    if (draft?.id === id) {
      cancelPendingLiveUpdate();
      onLiveUpdate?.(null);
      confirming.current = true;
      updateDraft(null);
      queueMicrotask(() => { confirming.current = false; });
    }
    const patch = captionListPatch(captions, items, fps, [{ id, text: null }]);
    if (patch) onUpdate(patch);
    const nextSelected = selected.filter((entry) => entry !== id);
    if (nextSelected.length !== selected.length) {
      setLocalSelection(nextSelected);
      if (nextSelected.length === 0) onSelectCaption?.(null);
    }
  };
  const replaceAll = () => {
    const edits = replacementEdits;
    const patch = captionListPatch(captions, items, fps, edits);
    if (patch) { cancelPendingLiveUpdate(); onLiveUpdate?.(null); onUpdate(patch); updateDraft(null); setNotice(t('已替换当前轨道的 {n} 句字幕，可撤销。', { n: edits.length })); }
  };
  const first = Math.max(0, firstIndexForOffset(offsets, scrollTop) - 2);
  const end = Math.min(visible.length, first + 16);
  const editedIndex = draft ? visible.findIndex((row) => captionListId(row) === draft.id) : -1;
  const rendered: Array<{ row: CueRow; index: number }> = [];
  if (editedIndex >= 0 && editedIndex < first) rendered.push({ row: visible[editedIndex]!, index: editedIndex });
  for (let index = first; index < end; index += 1) rendered.push({ row: visible[index]!, index });
  if (editedIndex >= end) rendered.push({ row: visible[editedIndex]!, index: editedIndex });
  const { pendingPatch, showPendingRecovery } = useMemo(() => {
    if (pendingRecovery.length === 0) return { pendingPatch: null, showPendingRecovery: false };
    const currentCaptionSignature = captionDataSignature(captions);
    const patch = pendingRecovery.every((entry) => entry.timelineId === timelineId && entry.trackId === captionTrackId)
      ? planPendingCaptionRecovery(captions, pendingRecovery) : null;
    return {
      pendingPatch: patch,
      showPendingRecovery: pendingRecovery.at(-1)?.targetSignature !== currentCaptionSignature,
    };
  }, [captions, pendingRecovery, timelineId, captionTrackId]);

  return <div className="cc-caption-list-workspace" data-caption-selection-owner="list">
    <div className="cc-caption-list-toolbar">
      <strong>{t('字幕列表')} · {rows.length}</strong>
      <label><input type="checkbox" checked={follow} onChange={(event) => {
        setFollow(event.target.checked); try { localStorage.setItem('cc.caption.list.follow', event.target.checked ? '1' : '0'); } catch {}
      }} />{t('自动跟随')}</label>
    </div>
    <details className="cc-caption-list-tools">
      <summary>{t('搜索与批量操作')}</summary>
      <div className="cc-caption-list-tools-body">
    <div className="cc-caption-list-search">
      <input className="cc-cap-input" type="search" value={query} placeholder={t('搜索当前轨道字幕')} aria-label={t('搜索当前轨道字幕')} onChange={(event) => { setQuery(event.target.value); setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }} />
      <input className="cc-cap-input" value={replacement} placeholder={t('替换为')} aria-label={t('替换为')} onChange={(event) => setReplacement(event.target.value)} />
      <button type="button" className="cc-cap-btn" disabled={!replacementEdits.length} onClick={replaceAll}>{t('全部替换')}</button>
    </div>
    <div className="cc-caption-list-toolbar">
      <button type="button" className="cc-cap-btn" disabled={!visible.length} onClick={() => {
        const selections = visible.flatMap((row) => { const value = captionListSelection(captionTrackId, row); return value ? [value] : []; });
        setLocalSelection(visible.map(captionListId));
        onSelectCaptionRange?.(selections, { additive: false, preserveWithItems: false });
      }}>{t('全选')}</button>
      <button type="button" className="cc-cap-btn" disabled={!selected.length} onClick={removeSelected}>{t('删除所选')}</button>
    </div>
      </div>
    </details>
    {notice && <div className="cc-cap-row-actions">
      <p className="cc-cap-hint" role="status">{notice}</p>
      {draft && <button type="button" className="cc-cap-btn sm" onClick={() => { commitFailed.current = false; suppressCenterIdRef.current = null; updateDraft(null); setNotice(''); }}>{t('取消编辑')}</button>}
    </div>}
    {showPendingRecovery && <section className="cc-caption-list-draft" role="region" aria-label={t('字幕恢复副本')}>
      <strong>{t('有未保存的字幕修改')}</strong>
      <p className="cc-cap-hint" role="status">{pendingPatch
        ? t('修改副本仍在本机。可恢复到当前字幕列表，也可以先复制下面的文字。')
        : t('工程字幕已发生变化，恢复副本不会自动覆盖；请先复制或丢弃。')}</p>
      {pendingRecovery.map((entry, index) => <textarea key={`${entry.targetSignature}:${index}`} className="cc-cap-input cc-cap-textarea"
        rows={2} value={entry.draft.text} aria-label={t('待恢复字幕文字 {n}', { n: index + 1 })} readOnly />)}
      <div className="cc-cap-row-actions">
        <button type="button" className="cc-cap-btn primary" disabled={!pendingPatch} onClick={() => {
          if (!pendingPatch) return;
          onUpdate(pendingPatch);
          setNotice(t('已恢复字幕修改，可撤销。'));
        }}>{t('恢复字幕修改')}</button>
        <button type="button" className="cc-cap-btn" onClick={() => persistRecovery(draftRef.current, [])}>{t('丢弃恢复副本')}</button>
      </div>
    </section>}
    {!visible.length ? <p className="cc-cap-hint">{t(query ? '没有匹配的字幕。' : '还没有字幕，请先生成或手动添加。')}</p> :
      <div className="cc-caption-list-scroll" ref={listRef} role="listbox" aria-label={t('字幕列表')} aria-multiselectable
        onPointerDown={(event) => {
          const el = event.currentTarget;
          const rect = el.getBoundingClientRect();
          if (pointerReleaseTimerRef.current) {
            clearTimeout(pointerReleaseTimerRef.current);
            pointerReleaseTimerRef.current = null;
          }
          pointerDownInListRef.current = true;
          // Allow dragging the native vertical scrollbar; lock list scroll when dragging inside rows/inputs.
          dragScrollLockRef.current = event.clientX >= rect.left + el.clientWidth ? null : el.scrollTop;
        }}
        onWheel={() => { dragScrollLockRef.current = null; centerTargetRef.current = null; pendingCenterRef.current = null; }}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (dragScrollLockRef.current !== null) {
            if (el.scrollTop !== dragScrollLockRef.current) el.scrollTop = dragScrollLockRef.current;
            return;
          }
          setScrollTop(el.scrollTop);
        }}>
        <div className="cc-caption-list-spacer" style={{ height: totalHeight }}>
          {rendered.map(({ row, index }) => {
            const id = captionListId(row);
            const rowTop = offsets[index] ?? index * BASE_ROW_HEIGHT;
            const inlineRows = draft?.id === id
              ? Math.min(6, Math.max(2, draft.text.split('\n').length, Math.ceil(Math.max(1, draft.text.length) / 18)))
              : 2;
            return <div key={id} data-cue-id={id} role="option" tabIndex={0} aria-selected={selectedSet.has(id)}
              ref={(node) => {
                const prev = rowNodesRef.current.get(id);
                if (prev === node) return;
                if (prev) {
                  observerRef.current?.unobserve(prev);
                  rowNodesRef.current.delete(id);
                }
                if (node) {
                  rowNodesRef.current.set(id, node);
                  observerRef.current?.observe(node);
                }
              }}
              className={`cc-caption-list-row${selectedSet.has(id) ? ' selected' : ''}${activeId === id ? ' current' : ''}`}
              style={{ top: rowTop }}
              onClick={() => {
                if (draft?.id !== id) edit(row);
                else {
                  pick(row);
                  editorRef.current?.focus();
                }
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter') { event.preventDefault(); edit(row); }
                if (event.key === ' ') { event.preventDefault(); pick(row, event); }
              }}>
              <div className="cc-caption-list-row-content">
                {draft?.id === id ? <textarea ref={editorRef} className="cc-caption-list-inline" rows={inlineRows} value={draft.text} aria-label={t('字幕文字')}
                  onClick={(event) => event.stopPropagation()}
                  onFocus={() => {
                    confirming.current = false;
                    const recent = lastPickSeekRef.current;
                    if (recent && recent.id === id && performance.now() - recent.at < 250) {
                      lastPickSeekRef.current = null;
                      return;
                    }
                    onSeekMs?.(row.start);
                  }}
                  onChange={(event) => {
                    commitFailed.current = false;
                    const nextDraft = { ...draft, text: event.target.value };
                    updateDraftTyping(nextDraft);
                    if (!composing.current) scheduleLiveUpdate(nextDraft);
                  }}
                  onCompositionStart={() => { composing.current = true; cancelPendingLiveUpdate(); }}
                  onCompositionEnd={() => {
                    composing.current = false;
                    if (draftRef.current) scheduleLiveUpdate(draftRef.current);
                  }}
                  onBlur={() => { if (!confirming.current) commit(true); }}
                  onKeyDown={onDraftKeyDown} /> :
                  <span className="cc-caption-list-text" style={row.fontOverride?.fontFamily ? { fontFamily: row.fontOverride.fontFamily } : undefined}>{row.text}</span>}
              </div>
              <div className="cc-caption-list-row-actions">
                <button type="button" className="cc-cap-btn ghost icon" title={t('在后面添加新字幕')} aria-label={t('在后面添加新字幕：{text}', { text: row.text })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); addAfter(row); }}>
                  <Icon name="plus" size={14} />
                </button>
                <button type="button" className="cc-cap-btn ghost icon danger" title={t('删除这句字幕')} aria-label={t('删除字幕：{text}', { text: row.text })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); removeRow(row); }}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>;
          })}
        </div>
      </div>}
  </div>;
}
