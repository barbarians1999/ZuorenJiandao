import type { EditorCommands } from '../../editor/storeCommands';
import { selectedIdsOf, type TimelineState } from '../../editor/types';
import { groupedItemIds } from '../../editor/linkGroups';
import { removeItemsFromState } from '../../editor/multiSelect';
import { planClipPasteResult } from '../../editor/clipPaste';
import { mainTrackId, planDirectionalChange, planMagneticDelete, type MagneticPlan } from '../../editor/magneticTimeline';
import type { ItemClipboard, TimelineShortcutApi } from '../../shortcuts/timelineApi';

interface ClipboardActionDeps {
  state: TimelineState;
  commands: Pick<EditorCommands, 'applyState' | 'selectItems'>;
  clipboard: { current: ItemClipboard };
  playhead: () => number;
  uid: (prefix: string) => string;
  reportError: (error: string) => void;
  copySelectedCaptions: () => boolean;
  pasteCaptionClipboard: () => boolean;
}

/** These are the actual menu/keyboard operations; hook/UI only supply dependencies. */
export function createTimelineClipboardActions(deps: ClipboardActionDeps): Pick<TimelineShortcutApi,
  'copySelected' | 'cutSelected' | 'pasteClipboard' | 'duplicateSelected' | 'deleteSelected'> {
  const { state, commands } = deps;
  const ids = () => groupedItemIds(state, selectedIdsOf(state));
  const selection = () => {
    const selected = new Set(ids());
    return state.items.filter((item) => selected.has(item.id));
  };
  const copy = (items = selection()) => {
    if (!items.length) return false;
    const copiedIds = new Set(items.map((item) => item.id));
    deps.clipboard.current = {
      kind: 'item', item: structuredClone(items[items.length - 1]!),
      multi: items.length > 1 ? structuredClone(items) : undefined,
      tracks: structuredClone(state.tracks ?? {}), sourceMainTrackId: mainTrackId(state),
      groups: structuredClone((state.linkGroups ?? []).filter((group) => group.itemIds.every((id) => copiedIds.has(id)))),
    };
    return true;
  };
  const commit = (result: MagneticPlan) => {
    if (result.error) { deps.reportError(result.error); return; }
    if (result.state === state) return;
    commands.applyState(result.state);
    commands.selectItems(selectedIdsOf(result.state));
  };
  const remove = (ripple: boolean) => {
    const selectedIds = ids();
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    commit(state.interaction?.magnet && state.items.some((item) => selected.has(item.id) && item.track === mainTrackId(state))
      ? planMagneticDelete(state, selectedIds)
      : planDirectionalChange(state, removeItemsFromState(state, selectedIds, ripple)));
  };
  return {
    copySelected: () => { if (!deps.copySelectedCaptions()) copy(); },
    cutSelected: () => {
      // Validate first so a locked/rejected cut neither changes the clipboard nor deletes clips.
      const result = state.interaction?.magnet
        ? planMagneticDelete(state, ids())
        : planDirectionalChange(state, removeItemsFromState(state, ids()));
      if (result.error) { deps.reportError(result.error); return; }
      // Cut removes structural linked A/V and enabled directional followers too.
      // The clipboard must include exactly those removed clips, not only the
      // explicit selection, otherwise a cut/paste would silently lose titles.
      const retained = new Set(result.state.items.map((item) => item.id));
      const removed = state.items.filter((item) => !retained.has(item.id));
      if (result.state !== state && copy(removed)) commit(result);
    },
    pasteClipboard: () => {
      if (deps.pasteCaptionClipboard()) return;
      const clip = deps.clipboard.current;
      if (!clip) return;
      commit(planClipPasteResult(state, clip.multi?.length ? clip.multi : [clip.item], clip.tracks, deps.playhead(), deps.uid, {
        sourceMainTrackId: clip.sourceMainTrackId, groups: clip.groups,
      }));
    },
    duplicateSelected: () => {
      const items = selection();
      if (!items.length) return;
      const end = Math.max(...items.map((item) => item.startFrame + item.durationInFrames));
      commit(planClipPasteResult(state, items, state.tracks, end, deps.uid, {
        sourceMainTrackId: mainTrackId(state), groups: state.linkGroups, keepSourceTracks: true,
      }));
    },
    deleteSelected: remove,
  };
}
