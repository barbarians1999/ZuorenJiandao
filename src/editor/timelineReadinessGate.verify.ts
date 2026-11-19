import assert from 'node:assert/strict';
import { loadTimelineFonts } from '../fonts/projectFonts';
import { prepareTimelineReadiness } from './timelineReadiness';
import type { TimelineState } from './types';

function makeStateWithMissingFontAsset(): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    assets: [],
    items: [
      {
        id: 'text-missing-font',
        kind: 'text',
        name: '标题',
        track: 'T1',
        startFrame: 0,
        durationInFrames: 60,
        props: {
          text: '测试字幕',
          fontFamily: 'Missing Custom Font',
          fontAssetId: 'missing-font-asset-id',
        },
      },
    ],
  };
}

const sampleState = makeStateWithMissingFontAsset();

// 1. Export mode (isRendering: true) must pass tolerateErrors: false and fail closed on font errors.
let observedExportOpts: { tolerateErrors?: boolean } | undefined;
await assert.rejects(
  prepareTimelineReadiness([sampleState], {
    isRendering: true,
    loadFonts: async (_state, opts) => {
      observedExportOpts = opts;
      throw new Error('font missing during render');
    },
    prepareTemplates: async () => undefined,
  }),
  /font missing during render/,
);
assert.equal(observedExportOpts?.tolerateErrors, false);

// 2. Preview mode (isRendering: false) must pass tolerateErrors: true and keep templates strict.
let observedPreviewOpts: { tolerateErrors?: boolean } | undefined;
await prepareTimelineReadiness([sampleState], {
  isRendering: false,
  loadFonts: async (_state, opts) => {
    observedPreviewOpts = opts;
  },
  prepareTemplates: async () => undefined,
});
assert.equal(observedPreviewOpts?.tolerateErrors, true);

await assert.rejects(
  prepareTimelineReadiness([sampleState], {
    isRendering: false,
    loadFonts: async () => undefined,
    prepareTemplates: async () => {
      throw new Error('broken template');
    },
  }),
  /broken template/,
);

// 3. Real loadTimelineFonts degrades with a warning in preview mode and fails closed in strict mode.
await assert.rejects(loadTimelineFonts(sampleState), /缺少字体/);
const warnings: unknown[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args);
};
try {
  await loadTimelineFonts(sampleState, { tolerateErrors: true });
} finally {
  console.warn = originalWarn;
}
assert.equal(warnings.length, 1, 'preview mode logs one warning instead of blanking the canvas');

console.log('timelineReadinessGate.verify: preview tolerates font failures while export remains strict');
