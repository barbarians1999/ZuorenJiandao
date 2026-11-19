import { Composition } from 'remotion';
import { TimelineComposition } from '../src/editor/TimelineComposition';
import { collectOverlayCaptionTiming } from '../src/captions/overlaySpans';
import { timelineDuration, type TimelineState } from '../src/editor/types';
import { resolveTimelineRenderPlan } from '../src/editor/sequenceGraph';
import { loadProjectFonts } from '../src/fonts/googleFonts';

// Register local faces; TimelineComposition registers used Google faces before render.
loadProjectFonts();

// A single composition that renders the entire editor timeline. Its dimensions
// and length are derived per-render from the `state` input prop, so the headless
// render matches whatever the Player shows in the browser.
const EMPTY_STATE: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
};

export function Root() {
  return (
    <Composition
      id="timeline"
      component={TimelineComposition}
      defaultProps={{ state: EMPTY_STATE, transparent: false }}
      // Metadata comes from the timeline itself — same source of truth as the
      // Player (see timelineDuration in src/editor/types.ts). Min 1 frame.
      calculateMetadata={({ props }) => {
        const { state, project, timelineId, __collectOverlaySpans, ...rest } = props;
        const durationInFrames = project && timelineId
          ? resolveTimelineRenderPlan(project, timelineId).durationInFrames
          : timelineDuration(state);
        const clampedDuration = Math.max(1, durationInFrames);
        const spanRange = __collectOverlaySpans as { rangeStart?: number; rangeEnd?: number } | undefined;
        const overlayCaptionInfo = spanRange
          ? collectOverlayCaptionTiming(
            state,
            Math.max(0, Math.floor(spanRange.rangeStart ?? 0)),
            Math.min(clampedDuration, Math.ceil(spanRange.rangeEnd ?? clampedDuration)),
          )
          : undefined;
        return {
          durationInFrames: clampedDuration,
          fps: state.fps,
          width: state.width,
          height: state.height,
          ...(overlayCaptionInfo
            ? { props: { state, project, timelineId, ...rest, __overlayCaptionInfo: overlayCaptionInfo } }
            : {}),
        };
      }}
      // Fallbacks only; calculateMetadata overrides these before every render.
      durationInFrames={Math.max(1, timelineDuration(EMPTY_STATE))}
      fps={EMPTY_STATE.fps}
      width={EMPTY_STATE.width}
      height={EMPTY_STATE.height}
    />
  );
}
