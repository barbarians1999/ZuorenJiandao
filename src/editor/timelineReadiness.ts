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

/** Preview can paint with fallback fonts while they load. Templates and export still require readiness. */
export function prepareTimelineReadiness(
  states: readonly TimelineState[],
  deps: TimelineReadinessDeps = {},
): Promise<void> {
  const isRendering = deps.isRendering ?? getRemotionEnvironment().isRendering;
  const loadFonts = deps.loadFonts ?? loadTimelineFonts;
  const prepareTemplates = deps.prepareTemplates ?? prepareTimelineTemplates;
  const fonts = Promise.all(states.map((entry) => loadFonts(entry, { tolerateErrors: !isRendering })));
  const templates = Promise.all(states.map(prepareTemplates));
  if (isRendering) return Promise.all([fonts, templates]).then(() => undefined);
  void fonts.catch((error: unknown) => console.warn('[TimelineReadinessGate] font preload degraded in preview:', error));
  return templates.then(() => undefined);
}
