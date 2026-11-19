export interface TimelineHoverPreviewActivity {
  hoverPreviewEnabled: boolean;
  playing: boolean;
  drag: unknown;
  marquee: unknown;
  pickDrag: unknown;
  pointerButtons?: number;
}

/** Clears the preview when playback, a gesture, a pressed pointer, or the preference makes it inactive. */
export function clearHoverPreviewForActivity(
  activity: TimelineHoverPreviewActivity,
  clear: () => void,
): boolean {
  const canKeepPreview = activity.hoverPreviewEnabled
    && !activity.playing
    && (activity.pointerButtons ?? 0) === 0
    && !activity.drag
    && !activity.marquee
    && !activity.pickDrag;
  if (canKeepPreview) return false;
  clear();
  return true;
}