import type { ProjectDoc, TimelineItem, TimelineState, TransitionItem } from '../../editor/types';

export function resolvePreviewRenderProject(
  project: ProjectDoc,
  timelineId: string,
  state: TimelineState,
): ProjectDoc {
  const existing = project.timelines.find((timeline) => timeline.id === timelineId);
  if (
    existing
    && state.items === existing.items
    && state.tracks === existing.tracks
    && state.trackOrder === existing.trackOrder
    && state.transitions === existing.transitions
    && state.captions === existing.captions
    && state.captionsHidden === existing.captionsHidden
    && state.fps === existing.fps
    && state.width === existing.width
    && state.height === existing.height
    && state.fit === existing.fit
    && state.watermark === existing.watermark
    && state.fxDefs === existing.fxDefs
    && state.compositingOrder === existing.compositingOrder
    && state.markers === existing.markers
    && state.linkGroups === existing.linkGroups
    && state.multicamGroups === existing.multicamGroups
    && state.interaction === existing.interaction
    && (state.assets === undefined || state.assets === project.assets)
  ) {
    return project;
  }
  return {
    ...project,
    timelines: project.timelines.map((timeline) => (
      timeline.id === timelineId
        ? {
            ...timeline,
            ...state,
            id: timeline.id,
            name: timeline.name,
            order: timeline.order,
            selectedId: null,
            selectedIds: undefined,
          }
        : timeline
    )),
  };
}

export function resolveSelectedPreviewTargetId(
  selectedItem: TimelineItem | null,
  transitions: readonly TransitionItem[] | undefined,
): string | undefined {
  if (!selectedItem) return undefined;
  if ((selectedItem.effects?.length ?? 0) > 0) return selectedItem.id;
  if (transitions?.some((transition) => transition.enabled !== false && transition.incomingItemId === selectedItem.id)) {
    return selectedItem.id;
  }
  return undefined;
}
