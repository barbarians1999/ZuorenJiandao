import type { Action } from './reducerActions';
import { activeTimeline, selectedIdsOf, type ProjectDoc, type Timeline } from './types';

export type SelectionAction = Extract<Action, { type: 'select' | 'selectMany' | 'selectAll' }>;

export interface TimelineSelection {
  selectedId: string | null;
  selectedIds: string[];
}

export type EditorSelectionState = Record<string, TimelineSelection>;

function liveSelection(timeline: Timeline, selection: TimelineSelection | undefined): TimelineSelection {
  const live = new Set(timeline.items.map((item) => item.id));
  const ids = (selection?.selectedIds ?? []).filter((id) => live.has(id));
  const selectedId = selection?.selectedId && ids.includes(selection.selectedId)
    ? selection.selectedId
    : ids.at(-1) ?? null;
  return { selectedId, selectedIds: ids };
}

export function selectionFromProject(doc: ProjectDoc): EditorSelectionState {
  return Object.fromEntries(doc.timelines.map((timeline) => [timeline.id, liveSelection(timeline, {
    selectedId: timeline.selectedId,
    selectedIds: selectedIdsOf(timeline),
  })]));
}

export function reduceSelection(
  current: EditorSelectionState,
  doc: ProjectDoc,
  action: SelectionAction,
): EditorSelectionState {
  const timeline = activeTimeline(doc);
  if (!timeline) return current;
  const previous = liveSelection(timeline, current[timeline.id]);
  let ids = [...previous.selectedIds];
  let selectedId: string | null = previous.selectedId;
  if (action.type === 'select') {
    if (action.id === null) {
      ids = [];
      selectedId = null;
    } else if (action.mode === 'toggle') {
      ids = ids.includes(action.id) ? ids.filter((id) => id !== action.id) : [...ids, action.id];
      selectedId = ids.at(-1) ?? null;
    } else if (action.mode === 'add') {
      if (!ids.includes(action.id)) ids.push(action.id);
      selectedId = action.id;
    } else {
      ids = [action.id];
      selectedId = action.id;
    }
  } else if (action.type === 'selectMany') {
    ids = action.ids.filter((id) => timeline.items.some((item) => item.id === id));
    selectedId = ids.at(-1) ?? null;
  } else {
    ids = timeline.items.map((item) => item.id);
    selectedId = ids.at(-1) ?? null;
  }
  const next = liveSelection(timeline, { selectedId, selectedIds: ids });
  if (next.selectedId === previous.selectedId
    && next.selectedIds.length === previous.selectedIds.length
    && next.selectedIds.every((id, index) => id === previous.selectedIds[index])) return current;
  return { ...current, [timeline.id]: next };
}

export function applySelection(state: Timeline, selection: EditorSelectionState): Timeline {
  const selected = liveSelection(state, selection[state.id]);
  return { ...state, selectedId: selected.selectedId, selectedIds: selected.selectedIds };
}

/** Remove session-only selection fields before a document enters persistence or history. */
export function stripTransientSelection(doc: ProjectDoc): ProjectDoc {
  return {
    ...doc,
    timelines: doc.timelines.map((timeline) => ({ ...timeline, selectedId: null, selectedIds: [] })),
  };
}
