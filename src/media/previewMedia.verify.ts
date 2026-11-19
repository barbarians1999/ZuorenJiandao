import assert from 'node:assert/strict';
import { requestPreviewProxy, retryPreviewProxy, resolvePreviewSrc, projectForPreview } from './previewMedia';
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

console.log('previewMedia.verify: ok');
