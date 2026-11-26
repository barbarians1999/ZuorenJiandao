import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { PlayerRef } from '@remotion/player';
import type { TimelineState } from '../../editor/types';
import type { CaptionsData } from '../../captions/types';

const mediaPoolCardSource = readFileSync(new URL('../../media/MediaPoolCard.tsx', import.meta.url), 'utf8');
assert.match(
  mediaPoolCardSource,
  /usePreviewMediaSource\(asset\.kind === 'video' \? asset\.src : undefined,\s*active\)/,
  'idle media pool cards must not trigger background proxy transcodes',
);

const localeId = '\0playback-smoothness-locale';
const server = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: 'playback-smoothness-locale',
    enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) {
      return id === localeId
        ? 'export const useT = () => (text) => text; export const t = (text) => text; export const tData = (text) => text;'
        : null;
    },
  }],
});

const previousFetch = globalThis.fetch;
try {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('usePreviewMediaSource(src, false) should never issue network requests');
  };

  const { usePreviewMediaSource } = await server.ssrLoadModule('/src/media/previewMedia.ts');
  function HookProbe({ src, enabled }: { src: string; enabled: boolean }) {
    const result = usePreviewMediaSource(src, enabled);
    return createElement('div', {
      'data-poster': result.posterSrc ?? '',
      'data-src': result.previewSrc ?? '',
    });
  }
  const probeHtml = renderToStaticMarkup(createElement(HookProbe, { src: '/media/uploads/demo.mp4', enabled: false }));
  assert.equal(fetchCalls, 0);
  assert.match(probeHtml, /data-poster="\/api\/media-poster\?src=%2Fmedia%2Fuploads%2Fdemo\.mp4"/);
  assert.match(probeHtml, /data-src="\/media\/uploads\/demo\.mp4"/);

  const { PreviewTransformOverlay } = await server.ssrLoadModule('/src/components/preview/PreviewTransformOverlay.tsx');
  const { PreviewMaskOverlay } = await server.ssrLoadModule('/src/components/preview/PreviewMaskOverlay.tsx');
  const { PreviewMosaicOverlay } = await server.ssrLoadModule('/src/components/preview/PreviewMosaicOverlay.tsx');
  const { CaptionPreviewEditor } = await server.ssrLoadModule('/src/captions/CaptionPreviewEditor.tsx');
  const { TrackHead } = await server.ssrLoadModule('/src/components/timeline/TrackHead.tsx');

  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: 'clip-1',
    trackOrder: ['C1', 'V1'],
    tracks: { C1: { kind: 'caption' }, V1: { kind: 'video' } },
    items: [{
      id: 'clip-1',
      name: 'clip',
      kind: 'solid',
      track: 'V1',
      startFrame: 0,
      durationInFrames: 90,
      mask: { type: 'rectangle', x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    }],
  };
  const captions: CaptionsData = {
    enabled: true,
    template: 'plain',
    pacing: 'phrase',
    sourceMode: 'item',
    sourceEntries: [{
      id: 'manual',
      itemId: 'manual:manual',
      words: [{ id: 'cue-1', text: '测试字幕', start: 0, end: 2000 }],
    }],
  };
  const playerRef = {
    current: {
      getCurrentFrame: () => 15,
      isPlaying: () => true,
      pause: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as PlayerRef,
  } as RefObject<PlayerRef | null>;
  const noop = () => undefined;

  assert.equal(
    renderToStaticMarkup(createElement(PreviewTransformOverlay, {
      state,
      playerRef,
      playing: true,
      onSelectItem: noop,
      onSetItemTransform: noop,
      onSetItemKeyframe: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    '',
    'PreviewTransformOverlay sleeps during playback',
  );
  assert.match(
    renderToStaticMarkup(createElement(PreviewTransformOverlay, {
      state,
      playerRef,
      playing: false,
      onSelectItem: noop,
      onSetItemTransform: noop,
      onSetItemKeyframe: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    /cc-preview-transform-overlay/,
    'PreviewTransformOverlay renders when paused',
  );

  assert.equal(
    renderToStaticMarkup(createElement(PreviewMaskOverlay, {
      state,
      playerRef,
      playing: true,
      onSetItemMask: noop,
      onSetItemKeyframe: noop,
      onRemoveItemKeyframe: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    '',
    'PreviewMaskOverlay sleeps during playback',
  );
  assert.match(
    renderToStaticMarkup(createElement(PreviewMaskOverlay, {
      state,
      playerRef,
      playing: false,
      onSetItemMask: noop,
      onSetItemKeyframe: noop,
      onRemoveItemKeyframe: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    /cc-preview-mask-overlay/,
  );

  assert.equal(
    renderToStaticMarkup(createElement(PreviewMosaicOverlay, {
      state,
      playerRef,
      playing: true,
      onSetItemEffects: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    '',
    'PreviewMosaicOverlay sleeps during playback',
  );
  assert.match(
    renderToStaticMarkup(createElement(PreviewMosaicOverlay, {
      state,
      playerRef,
      playing: false,
      onSetItemEffects: noop,
      onBeginHistoryGesture: noop,
      onEndHistoryGesture: noop,
    })),
    /cc-preview-mask-overlay/,
  );

  assert.equal(
    renderToStaticMarkup(createElement(CaptionPreviewEditor, {
      trackId: 'C1',
      state,
      captions,
      playerRef,
      playing: true,
      onUpdateCaptions: noop,
    })),
    '',
    'CaptionPreviewEditor sleeps during playback',
  );
  assert.match(
    renderToStaticMarkup(createElement(CaptionPreviewEditor, {
      trackId: 'C1',
      state,
      captions,
      playerRef,
      playing: false,
      onUpdateCaptions: noop,
    })),
    /data-caption-selection-owner="preview-caption"/,
  );

  const trackHeadHtml = renderToStaticMarkup(createElement(TrackHead, {
    trackId: 'V1',
    kind: 'video',
    trackName: '视频1',
    config: {},
    deleteBlockedReason: null,
    onDelete: noop,
    canMoveUp: true,
    canMoveDown: false,
    onMoveUp: noop,
    onMoveDown: noop,
    menuElevated: false,
    width: 212,
    commands: {} as never,
    onToggleCaptions: noop,
    onToggleCaptionMenu: noop,
    onToggleDuckMenu: noop,
    duckMenuPos: null,
    onCloseDuckMenu: noop,
  }));
  assert.match(trackHeadHtml, /aria-label="上移轨道层级"/);
  assert.match(trackHeadHtml, /disabled=""[^>]*aria-label="下移轨道层级"/);

  const { shouldMountPlayerSeparateAudio } = await server.ssrLoadModule('/src/editor/TimelineMediaLayer.tsx');
  const { requestPreviewProxy } = await server.ssrLoadModule('/src/media/previewMedia.ts');
  const silentSrc = '/media/uploads/silent-overlay-layer.webm';
  globalThis.fetch = async () => Response.json({
    source: { src: silentSrc, durationMs: 1000, width: 1920, height: 1080, codec: 'vp9', longGop: true, hasAlpha: true, hasAudio: false },
    proxy: { status: 'not-needed', reason: 'alpha-channel-preserved' },
  });
  await requestPreviewProxy(silentSrc);
  assert.equal(shouldMountPlayerSeparateAudio({ src: silentSrc }, false, false, true), false, 'silent video skips <Html5Audio> in Player');
  assert.equal(shouldMountPlayerSeparateAudio({ src: '/media/uploads/talk.mp4', audioDetached: true }, false, false, true), false, 'detached-audio clip skips separate <Html5Audio>');
  assert.equal(shouldMountPlayerSeparateAudio({ src: '/media/uploads/talk.mp4', volume: 0 }, false, false, true), false, '0-volume clip without volume keyframes skips <Html5Audio>');
  assert.equal(shouldMountPlayerSeparateAudio({ src: '/media/uploads/talk.mp4' }, false, false, true), true, 'normal audible video mounts <Html5Audio> in Player');
  assert.equal(shouldMountPlayerSeparateAudio({ src: silentSrc }, false, false, false), true, 'export rendering path stays unchanged');

  console.log('playbackSmoothness.verify: idle pool poster preserved, playback overlays sleep cleanly, TrackHead stepper bounds and silent audio gating OK');
} finally {
  globalThis.fetch = previousFetch;
  await server.close();
}
