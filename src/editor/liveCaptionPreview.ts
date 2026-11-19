import type { TimelineSelectionMovePreview } from '../captions/captionGroupMove';
import { moveTimelineSelectionByDelta } from '../captions/captionGroupMove';
import type { CaptionsData } from '../captions/types';
import type { TimelineState, TrackId } from './types';

export type LiveCaptionPreviewSource = 'timeline' | 'list' | 'preview';

export type LiveCaptionPreviewPatch =
  | {
      kind: 'patch';
      source: LiveCaptionPreviewSource;
      timelineId: string;
      trackId?: TrackId;
      patch: Partial<CaptionsData>;
    }
  | {
      kind: 'selectionMove';
      source: 'timeline';
      timelineId: string;
      preview: TimelineSelectionMovePreview;
    };

export type LiveCaptionPreviewInput =
  | {
      kind: 'patch';
      source: LiveCaptionPreviewSource;
      trackId?: TrackId;
      patch: Partial<CaptionsData>;
    }
  | {
      kind: 'selectionMove';
      source: 'timeline';
      preview: TimelineSelectionMovePreview;
    };

export function mergeLiveCaptionPatch(captions: CaptionsData, patch: Partial<CaptionsData>): CaptionsData {
  return {
    ...captions,
    ...patch,
    layout: patch.layout === undefined ? captions.layout : patch.layout,
  };
}

export function applyLiveCaptionPreview(
  state: TimelineState,
  timelineId: string | undefined,
  preview: LiveCaptionPreviewPatch | null,
): TimelineState {
  if (!preview || !timelineId || preview.timelineId !== timelineId) return state;
  if (preview.kind === 'selectionMove') {
    return moveTimelineSelectionByDelta(
      state,
      preview.preview.itemIds,
      preview.preview.captionSelections,
      preview.preview.deltaFrames,
    );
  }
  const trackId = preview.trackId;
  if (trackId && state.tracks?.[trackId]?.captions) {
    return {
      ...state,
      tracks: {
        ...state.tracks,
        [trackId]: {
          ...state.tracks[trackId]!,
          captions: mergeLiveCaptionPatch(state.tracks[trackId]!.captions!, preview.patch),
        },
      },
    };
  }
  if (state.captions) {
    return { ...state, captions: mergeLiveCaptionPatch(state.captions, preview.patch) };
  }
  return state;
}
