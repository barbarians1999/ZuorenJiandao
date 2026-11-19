import { getRemotionEnvironment } from 'remotion';
import { loadTimelineFonts } from '../fonts/projectFonts';
import { prepareTemplate } from '../template-host';
import type { TimelineState } from './types';

export interface TimelineReadinessDeps {
  isRendering?: boolean;
  loadFonts?: (state: TimelineState, opts?: { tolerateErrors?: boolean }) => Promise<void>;
  prepareTemplates?: (state: TimelineState) => Promise<void>;
}

function prepareTimelineTemplates(state: TimelineState): Promise<void> {
  const templates = state.items.filter((item) => item.kind === 'motion-graphic' && item.code);
  return Promise.all(templates.map(async (item) => {
    try {
      await prepareTemplate(item.code as string);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${item.name} — compile error:\n${message}`);
    }
  })).then(() => undefined);
}

/** Preload fonts and motion-graphic templates; preview tolerates missing fonts while export fails closed. */
export function prepareTimelineReadiness(
  states: readonly TimelineState[],
  deps: TimelineReadinessDeps = {},
): Promise<void> {
  const isRendering = deps.isRendering ?? getRemotionEnvironment().isRendering;
  const loadFonts = deps.loadFonts ?? loadTimelineFonts;
  const prepareTemplates = deps.prepareTemplates ?? prepareTimelineTemplates;
  return Promise.all(
    states.flatMap((entry) => [
      loadFonts(entry, { tolerateErrors: !isRendering }),
      prepareTemplates(entry),
    ]),
  ).then(() => undefined);
}
