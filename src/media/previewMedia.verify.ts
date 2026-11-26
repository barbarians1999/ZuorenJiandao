import assert from 'node:assert/strict';
import {
  requestPreviewProxy,
  retryPreviewProxy,
  resolvePreviewSrc,
  projectForPreview,
  memoizePreviewProjectDoc,
  memoizePreviewTimelineState,
  isPreviewSourceSilent,
  isPreviewSourceAlpha,
  isBrowserPlayableNativeAlpha,
  subscribePreviewSourceMeta,
  getPreviewSourceMetaVersion,
} from './previewMedia';
import { setPreviewSourceMode } from './qualityPolicy';
import { docFromTimeline } from '../persist/projectStore';

const source = '/media/uploads/preview-force-check.mp4';
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return Response.json({
    source: { src: source, durationMs: 1_000, width: 640, height: 360, codec: 'h264', longGop: false },
    proxy: calls === 1
      ? { status: 'not-needed', reason: 'source-compatible' }
      : { status: 'ready', reason: 'forced', previewSrc: '/api/preview-proxy-file?src=check' },
  });
};

await requestPreviewProxy(source);
await requestPreviewProxy(source, true);
await requestPreviewProxy(source, true);
assert.equal(calls, 2, 'forced proxy generation is retried once and cached after it is ready');

const failedSource = '/media/uploads/failed-proxy.mp4';
const urls: string[] = [];
globalThis.fetch = async (input) => {
  urls.push(String(input));
  return Response.json({ source: { src: failedSource }, proxy: urls.length === 1
    ? { status: 'failed', reason: 'disk-full', error: 'disk full' }
    : { status: 'ready', reason: 'retry', previewSrc: '/proxy-retried.mp4' } });
};
await requestPreviewProxy(failedSource, true);
await requestPreviewProxy(failedSource, true);
await requestPreviewProxy(failedSource);
assert.equal(urls.length, 1, 'failed proxy does not automatically regenerate');
await Promise.all([retryPreviewProxy(failedSource), retryPreviewProxy(failedSource)]);
assert.equal(urls.length, 2, 'concurrent explicit retries share one request');
assert.match(urls[1], /force=1&retry=1/);
setPreviewSourceMode('proxy');
assert.equal(resolvePreviewSrc(source, { status: 'loading', reason: 'preparing' }), source);
assert.equal(resolvePreviewSrc(source, { status: 'failed', reason: 'failed', error: 'x' }), source);
assert.equal(resolvePreviewSrc(source, { status: 'ready', reason: 'ready', previewSrc: '/proxy.mp4' }), '/proxy.mp4');
setPreviewSourceMode('original');
assert.equal(resolvePreviewSrc(source, { status: 'ready', reason: 'ready', previewSrc: '/proxy.mp4' }), source);
const state = { fps: 30, width: 1920, height: 1080, selectedId: null, fit: 'contain' as const,
  items: [{ id: 'v', name: 'original', kind: 'video' as const, track: 'V1', src: source, startFrame: 0, durationInFrames: 60 }] };
const project = docFromTimeline(state);
const child = { ...project.timelines[0], id: 'nested', items: [{ ...state.items[0], id: 'child' }] };
project.timelines.push(child);
const saved = JSON.stringify(project);
const view = projectForPreview(project, new Map([[source, '/proxy.mp4']]));
assert.equal(JSON.stringify(project), saved, 'persistent document / undo / export input stays unchanged');
assert.equal(view.timelines[1].items[0].src, '/proxy.mp4', 'nested timeline gets view-only substitution');
assert.equal(project.timelines[1].items[0].src, source);
assert.notEqual(view.timelines[0].items[0], project.timelines[0].items[0]);

const alphaSource = '/media/uploads/alpha-overlay.webm';
let alphaCalls = 0;
globalThis.fetch = async () => {
  alphaCalls++;
  return Response.json({
    source: { src: alphaSource, durationMs: 1_000, width: 1280, height: 720, codec: 'vp9', longGop: false, hasAlpha: true },
    proxy: { status: 'not-needed', reason: 'alpha-channel-preserved' },
  });
};
await requestPreviewProxy(alphaSource, true);
await requestPreviewProxy(alphaSource, true);
assert.equal(alphaCalls, 1, 'alpha-channel-preserved result is cached without redundant forced retries');
setPreviewSourceMode('proxy');
assert.equal(
  resolvePreviewSrc(alphaSource, { status: 'not-needed', reason: 'alpha-channel-preserved' }),
  alphaSource,
  'smooth proxy mode keeps original transparent source rather than black opaque fallback',
);

const firstUrls = new Map([[source, '/proxy.mp4']]);
const secondUrls = new Map([[source, '/proxy.mp4']]);
const changedUrls = new Map([[source, '/proxy-v2.mp4']]);
const memoProject1 = memoizePreviewProjectDoc(null, project, firstUrls);
const memoProject2 = memoizePreviewProjectDoc(memoProject1, project, secondUrls);
assert.equal(memoProject2.output, memoProject1.output, 'unchanged URL map preserves ProjectDoc reference across playing transitions');
const memoProject3 = memoizePreviewProjectDoc(memoProject2, project, changedUrls);
assert.notEqual(memoProject3.output, memoProject1.output, 'updated URL map derives a fresh ProjectDoc view');

const memoState1 = memoizePreviewTimelineState(null, state, firstUrls);
const memoState2 = memoizePreviewTimelineState(memoState1, state, secondUrls);
assert.equal(memoState2.output, memoState1.output, 'unchanged URL map preserves TimelineState reference');

const silentOverlay = '/media/uploads/silent-overlay.webm';
const silentProxyUrl = '/api/preview-proxy-file?src=%2Fmedia%2Fuploads%2Fsilent-overlay.webm&format=webm&revision=1';
globalThis.fetch = async () => Response.json({
  source: { src: silentOverlay, durationMs: 1000, width: 1920, height: 1080, codec: 'vp9', longGop: true, hasAlpha: true, hasAudio: false },
  proxy: { status: 'ready', reason: 'high-resolution-alpha', previewSrc: silentProxyUrl },
});
await requestPreviewProxy(silentOverlay);
assert.equal(isPreviewSourceSilent(silentOverlay), true, 'silent overlay original src is marked silent');
assert.equal(isPreviewSourceSilent(silentProxyUrl), true, 'silent overlay alpha proxy url is marked silent');

const audibleVideo = '/media/uploads/audible-clip.mp4';
globalThis.fetch = async () => Response.json({
  source: { src: audibleVideo, durationMs: 1000, width: 1280, height: 720, codec: 'h264', longGop: false, hasAlpha: false, hasAudio: true },
  proxy: { status: 'not-needed', reason: 'source-compatible' },
});
await requestPreviewProxy(audibleVideo);
assert.equal(isPreviewSourceSilent(audibleVideo), false, 'audible video is not marked silent');

assert.equal(isPreviewSourceAlpha('/media/uploads/overlay.webm'), true);
assert.equal(isPreviewSourceAlpha('/media/uploads/overlay.alpha.webm'), true);
assert.equal(isPreviewSourceAlpha('/api/preview-proxy-file?src=x.mov&format=webm&revision=1'), true);
assert.equal(isPreviewSourceAlpha('/media/uploads/clip.mp4'), false);
assert.equal(isBrowserPlayableNativeAlpha('/media/uploads/overlay.webm'), true);
assert.equal(isBrowserPlayableNativeAlpha('/api/preview-proxy-file?src=x.mov&format=webm&revision=1'), true);
assert.equal(isBrowserPlayableNativeAlpha('/media/uploads/clip.mp4'), false);

const alphaMovSrc = '/media/uploads/prores-alpha.mov';
const proxyAlphaMovSrc = '/api/preview-proxy-file?src=%2Fmedia%2Fuploads%2Fprores-alpha.mov&format=webm&revision=2';
globalThis.fetch = async () => Response.json({
  source: { src: alphaMovSrc, durationMs: 1000, width: 1280, height: 720, codec: 'prores', longGop: false, hasAlpha: true, hasAudio: false },
  proxy: { status: 'ready', reason: 'unstable-codec', previewSrc: proxyAlphaMovSrc },
});
await requestPreviewProxy(alphaMovSrc);
assert.equal(isPreviewSourceAlpha(alphaMovSrc), true, 'probed MOV with alpha is flagged alpha');
assert.equal(isBrowserPlayableNativeAlpha(alphaMovSrc), false, 'unproxied MOV is not routed directly to native Html5Video');
assert.equal(isBrowserPlayableNativeAlpha(proxyAlphaMovSrc), true, 'proxied MOV WebM is routed to native Html5Video');

const silentNotNeededSrc = '/media/uploads/silent-small-overlay.webm';
let metaNotifications = 0;
const versionBefore = getPreviewSourceMetaVersion();
const unsubscribeMeta = subscribePreviewSourceMeta(() => { metaNotifications += 1; });
globalThis.fetch = async () => Response.json({
  source: { src: silentNotNeededSrc, durationMs: 1000, width: 640, height: 360, codec: 'vp9', longGop: false, hasAlpha: true, hasAudio: false },
  proxy: { status: 'not-needed', reason: 'alpha-channel-preserved' },
});
await requestPreviewProxy(silentNotNeededSrc);
unsubscribeMeta();
assert.ok(metaNotifications >= 1, 'metadata subscribers are notified when silent/alpha probe resolves even with status=not-needed');
assert.ok(getPreviewSourceMetaVersion() > versionBefore, 'meta version bumps on silent/alpha probe resolution');

console.log('previewMedia.verify: ok');
