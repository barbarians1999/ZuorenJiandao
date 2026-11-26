import { useRef } from 'react';
import { usePersistedState } from './usePersistedState';

const HEADER_HEIGHT = 52;
const BASELINE_WIDTH = 1463;
const BASELINE_CONTENT_HEIGHT = 761;
const DEFAULT_LIBRARY_RATIO = 406 / BASELINE_WIDTH;
const DEFAULT_TIMELINE_RATIO = 350 / BASELINE_CONTENT_HEIGHT;
const MIN_LIBRARY_RATIO = 260 / BASELINE_WIDTH;
const MIN_PREVIEW_RATIO = 360 / BASELINE_WIDTH;
const MIN_TIMELINE_RATIO = 260 / BASELINE_CONTENT_HEIGHT;
const MIN_UPPER_RATIO = 300 / BASELINE_CONTENT_HEIGHT;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function finiteRatio(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
function viewportWidth(): number {
  return typeof window === 'undefined' ? BASELINE_WIDTH : Math.max(1, window.innerWidth);
}
function contentHeight(): number {
  return typeof window === 'undefined' ? BASELINE_CONTENT_HEIGHT : Math.max(1, window.innerHeight - HEADER_HEIGHT);
}
export interface EditorPanelLayout {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  librarySize: { value: number; min: number; max: number };
  timelineSize: { value: number; min: number; max: number };
  resizeLibrary: (delta: number) => void;
  resizeTimeline: (delta: number) => void;
  beginLibraryResize: () => void;
  cancelLibraryResize: () => void;
  resetLibrarySize: () => void;
  beginTimelineResize: () => void;
  cancelTimelineResize: () => void;
  resetTimelineSize: () => void;
}

/** Media library + preview above a full-width timeline; no embedded chat column. */
export function useEditorPanelLayout(): EditorPanelLayout {
  const [storedLibraryRatio, setLibraryRatio] = usePersistedState('openchatcut.libraryRatio.ui-v3', DEFAULT_LIBRARY_RATIO, { writeDebounceMs: 250 });
  const [storedTimelineRatio, setTimelineRatio] = usePersistedState('openchatcut.timelineRatio.ui-v2', DEFAULT_TIMELINE_RATIO, { writeDebounceMs: 250 });
  const libraryRatio = clamp(finiteRatio(storedLibraryRatio, DEFAULT_LIBRARY_RATIO), MIN_LIBRARY_RATIO, 1 - MIN_PREVIEW_RATIO);
  const timelineRatio = clamp(finiteRatio(storedTimelineRatio, DEFAULT_TIMELINE_RATIO), MIN_TIMELINE_RATIO, 1 - MIN_UPPER_RATIO);
  const libraryRatioAtDragStart = useRef(libraryRatio);
  const timelineRatioAtDragStart = useRef(timelineRatio);
  const gridTemplateColumns = `minmax(0, ${libraryRatio * 100}vw) 5px minmax(0, 1fr)`;
  const gridTemplateRows = `${HEADER_HEIGHT}px minmax(0, 1fr) 5px minmax(0, calc((100vh - ${HEADER_HEIGHT}px) * ${timelineRatio}))`;
  const resizeLibrary = (delta: number) => setLibraryRatio((current) => roundRatio(clamp(
    finiteRatio(current, DEFAULT_LIBRARY_RATIO) + delta / viewportWidth(), MIN_LIBRARY_RATIO, 1 - MIN_PREVIEW_RATIO,
  )));
  const resizeTimeline = (delta: number) => setTimelineRatio((current) => roundRatio(clamp(
    finiteRatio(current, DEFAULT_TIMELINE_RATIO) - delta / contentHeight(), MIN_TIMELINE_RATIO, 1 - MIN_UPPER_RATIO,
  )));
  return {
    gridTemplateColumns,
    gridTemplateRows,
    librarySize: { value: libraryRatio * 100, min: MIN_LIBRARY_RATIO * 100, max: (1 - MIN_PREVIEW_RATIO) * 100 },
    timelineSize: { value: timelineRatio * 100, min: MIN_TIMELINE_RATIO * 100, max: (1 - MIN_UPPER_RATIO) * 100 },
    resizeLibrary,
    resizeTimeline,
    beginLibraryResize: () => { libraryRatioAtDragStart.current = libraryRatio; },
    cancelLibraryResize: () => setLibraryRatio(libraryRatioAtDragStart.current),
    resetLibrarySize: () => setLibraryRatio(DEFAULT_LIBRARY_RATIO),
    beginTimelineResize: () => { timelineRatioAtDragStart.current = timelineRatio; },
    cancelTimelineResize: () => setTimelineRatio(timelineRatioAtDragStart.current),
    resetTimelineSize: () => setTimelineRatio(DEFAULT_TIMELINE_RATIO),
  };
}
