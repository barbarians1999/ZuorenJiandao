import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { inspectBrowserExport, renderTimelineInBrowser } from '../src/export/browserExport';
import { sourceFrameAt } from '../src/editor/sourceLimit';
import { clipOpacityAt } from '../src/editor/clipFade';
import { compositionPlan } from '../src/editor/compositionPlan';
import type { TimelineState } from '../src/editor/types';
import { dissolveBarcode, matchDissolveFrames } from './long-video-metrics.mjs';

const presented = new Map<HTMLVideoElement, { mediaTime: number; at: number }>();
const canvasPresented = new Map<HTMLCanvasElement, { mediaTime: number; at: number }>();
const compositePresented = new Map<HTMLCanvasElement, { bits: number[]; at: number }>();
const readback = document.createElement('canvas');
readback.width = 304; readback.height = 1;
let capturePresentation = false;
let playbackDraws = 0;
let capturePlayback = false;
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
function sampleCanvas(canvas: HTMLCanvasElement) {
  if (canvas.width < 300 || canvas.height < 180 || !canvas.isConnected || !visible(canvas)) return;
  try {
    let context = canvas.getContext('2d');
    const y = Math.round(148 / 1080 * canvas.height);
    const isComposite = !context;
    if (isComposite) {
      context = readback.getContext('2d')!;
      // GL runtime preserves its drawing buffer. Copy only the barcode row;
      // bypass the instrumentation wrapper and never mutate the product canvas.
      drawImage.call(context, canvas, 0, y, 304 / 1920 * canvas.width, 1, 0, 0, 304, 1);
    }
    const row = context!.getImageData(0, isComposite ? 0 : y, isComposite ? 304 : Math.ceil(304 / 1920 * canvas.width), 1).data;
    const valueAt = (x: number) => row[Math.round(isComposite ? x : x / 1920 * canvas.width) * 4];
    if (valueAt(280) < 200 || valueAt(264) > 40) return;
    if (isComposite) {
      const black = valueAt(264), range = valueAt(280) - black;
      compositePresented.set(canvas, { bits: Array.from({ length: 16 }, (_, bit) => (valueAt(bit * 16 + 8) - black) / range), at: performance.now() });
      return;
    }
    let frame = 0;
    for (let bit = 0; bit < 16; bit++) if (valueAt(bit * 16 + 8) > 128) frame |= 1 << bit;
    canvasPresented.set(canvas, { mediaTime: frame / 30, at: performance.now() });
  } catch { /* Non-fixture/tainted canvas cannot count as presentation. */ }
}
// @remotion/media uses decoded canvas frames, with HTML5 video as a fallback.
// Read the fixture's binary frame number AFTER the visible canvas is painted.
CanvasRenderingContext2D.prototype.drawImage = (function (this: CanvasRenderingContext2D, ...args: Parameters<typeof drawImage>) {
  drawImage.apply(this, args);
  if (!(this.canvas instanceof HTMLCanvasElement) || !this.canvas.isConnected || !visible(this.canvas)) return;
  if (capturePlayback) playbackDraws++;
  if (capturePresentation) sampleCanvas(this.canvas);
}) as typeof drawImage;
const watching = new WeakSet<HTMLVideoElement>();
function observeVideos() {
  for (const video of document.querySelectorAll('video')) {
    if (watching.has(video)) continue;
    watching.add(video);
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      presented.set(video, { mediaTime: metadata.mediaTime, at: performance.now() });
      if (video.isConnected) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
}
new MutationObserver(observeVideos).observe(document.documentElement, { childList: true, subtree: true });
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const visible = (element: HTMLElement) => {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return element.getBoundingClientRect().width > 0;
};


export function presentationProbe(getState: () => TimelineState, player: RefObject<PlayerRef | null>) {
  return {
      seek: async (frame: number, observeOnly = false) => {
        const state = getState();
        const started = performance.now();
        capturePresentation = true;
        for (const canvas of canvasPresented.keys()) if (!canvas.isConnected) canvasPresented.delete(canvas);
        for (const canvas of compositePresented.keys()) if (!canvas.isConnected) compositePresented.delete(canvas);
        for (const video of presented.keys()) if (!video.isConnected) presented.delete(video);
        player.current!.pause();
        const transition = state.transitions?.find((entry) => {
          const incoming = state.items.find((item) => item.id === entry.incomingItemId)!;
          const from = incoming.startFrame - Math.floor(entry.durationInFrames / 2);
          return frame >= from && frame < from + entry.durationInFrames;
        });
        const transitionIds = transition ? [transition.outgoingItemId, transition.incomingItemId] : [];
        // Plan the destination, not the old canvas still visible before seeking.
        const exactTransition = transition && compositionPlan(state, {
          mode: 'player', selectedItemId: state.selectedId,
        }).glWindows.some((window) => window.key === transition.id);
        const expected = state.items.filter((item) => item.kind === 'video' && (!transitionIds.includes(item.id) || !exactTransition) && frame >= item.startFrame
          && frame < item.startFrame + item.durationInFrames && clipOpacityAt(item, frame - item.startFrame) > 0)
          .map((item) => sourceFrameAt(item, frame - item.startFrame) / state.fps);
        let expectedComposite: number[] | null = null;
        let compositeTiming: { outgoing: number; incoming: number; progress: number } | null = null;
        if (transition && !exactTransition) {
          // CSS approximation: validate both visible source surfaces, not a GL
          // composite barcode. Never label this as final-effect verification.
          const incoming = state.items.find((item) => item.id === transition.incomingItemId)!;
          const from = incoming.startFrame - Math.floor(transition.durationInFrames / 2);
          const progress = (frame - from) / Math.max(1, transition.durationInFrames - 1);
          for (const id of transitionIds) {
            if ((id === transition.outgoingItemId && progress >= 1)
              || (id === transition.incomingItemId && progress <= 0)) continue;
            const item = state.items.find((candidate) => candidate.id === id)!;
            const time = sourceFrameAt(item, frame - item.startFrame) / state.fps;
            if (!expected.includes(time)) expected.push(time);
          }
        }
        if (transition && exactTransition) {
          const outgoing = state.items.find((item) => item.id === transition.outgoingItemId)!;
          const incoming = state.items.find((item) => item.id === transition.incomingItemId)!;
          const from = incoming.startFrame - Math.floor(transition.durationInFrames / 2);
          expectedComposite = dissolveBarcode(sourceFrameAt(outgoing, frame - outgoing.startFrame),
            sourceFrameAt(incoming, frame - incoming.startFrame), (frame - from) / (transition.durationInFrames - 1));
          compositeTiming = { outgoing: sourceFrameAt(outgoing, frame - outgoing.startFrame),
            incoming: sourceFrameAt(incoming, frame - incoming.startFrame), progress: (frame - from) / (transition.durationInFrames - 1) };
        }
        if (!observeOnly) player.current!.seekTo(frame);
        while (performance.now() - started < 15000) {
          observeVideos();
          // A correctly predecoded premount may become visible without another drawImage.
          // Sample the visible canvas, rather than requiring an unnecessary redraw.
          if (player.current!.getCurrentFrame() === frame) {
            for (const canvas of document.querySelectorAll('canvas')) sampleCanvas(canvas);
          }
          const actual = [...presented, ...canvasPresented].filter(([element, value]) => element.isConnected && visible(element) && value.at >= started).map(([, value]) => value.mediaTime);
          const compositeMatch = compositeTiming ? [...compositePresented].filter(([element, value]) =>
            element.isConnected && visible(element) && value.at >= started).map(([, value]) =>
            matchDissolveFrames(value.bits, compositeTiming!.outgoing, compositeTiming!.incoming, compositeTiming!.progress)).find(Boolean) : null;
          const compositeMatched = !expectedComposite || Boolean(compositeMatch);
          if (player.current!.getCurrentFrame() === frame && (expected.length || expectedComposite) && compositeMatched
            && expected.every((time) => actual.some((value) => Math.abs(value - time) <= 1.01 / state.fps))) {
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            capturePresentation = false;
            return { frame, status: 'presented', elapsedMs: performance.now() - started, expected, actual,
              presentationToleranceFrames: 1,
              exactSourceFrames: expected.every((time) => actual.some((value) => Math.abs(value - time) < 0.01 / state.fps))
                && (!compositeTiming || compositeMatch?.exact === true),
              previewFidelity: transition && !exactTransition ? 'lightweight-source-frames-only' : 'exact-source-frames',
              transition: transition?.id, compositeMatched: expectedComposite ? compositeMatched : null, compositeMatch };
          }
          await sleep(10);
        }
        capturePresentation = false;
        return { frame, status: 'timeout', elapsedMs: performance.now() - started, expected,
          playerFrame: player.current!.getCurrentFrame(),
          canvasVisibility: [...canvasPresented].filter(([canvas]) => canvas.isConnected).map(([canvas, value]) => ({
            visible: visible(canvas), width: canvas.width, height: canvas.height, mediaTime: value.mediaTime, at: value.at })),
          videoPositions: [...document.querySelectorAll('video')].map((video) => ({ src: video.currentSrc,
            time: video.currentTime, readyState: video.readyState, seeking: video.seeking, duration: video.duration })),
          transition: transition?.id, expectedComposite,
          compositeActual: [...compositePresented].filter(([element]) => element.isConnected && visible(element)).map(([, value]) => value.bits),
          actual: [...presented, ...canvasPresented].filter(([element]) => element.isConnected).map(([, value]) => value.mediaTime) };
      },
      playback: async (seconds: number, { startFrame = 0, warmupSeconds = 0 }: { startFrame?: number; warmupSeconds?: number } = {}) => {
        if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(startFrame) || startFrame < 0
          || !Number.isFinite(warmupSeconds) || warmupSeconds < 0) throw new Error('Invalid playback sample range');
        const state = getState();
        player.current!.pause();
        player.current!.seekTo(startFrame);
        // seekTo updates React asynchronously. Never count the absolute end frame as advancement.
        const seekStarted = performance.now();
        while (player.current!.getCurrentFrame() !== startFrame) {
          if (performance.now() - seekStarted > 15000) throw new Error('Playback starting frame did not settle');
          await sleep(10);
        }
        capturePresentation = false;
        if (warmupSeconds) { player.current!.play(); await sleep(warmupSeconds * 1000); }
        const initialFrame = player.current!.getCurrentFrame();
        capturePlayback = true; playbackDraws = 0;
        let skippedTimelineFrames = 0, lastFrame = initialFrame;
        let firstAdvanceMs: number | null = null;
        const frameSamples: { elapsedMs: number; frame: number }[] = [];
        const onFrame = ({ detail }: { detail: { frame: number } }) => {
          if (detail.frame > lastFrame) skippedTimelineFrames += Math.max(0, detail.frame - lastFrame - 1);
          if (detail.frame > initialFrame && firstAdvanceMs === null) firstAdvanceMs = performance.now() - started;
          lastFrame = detail.frame;
        };
        player.current!.addEventListener('frameupdate', onFrame);
        const before = new Map([...document.querySelectorAll('video')].map((video) => [video, video.getVideoPlaybackQuality()]));
        const started = performance.now(); player.current!.play();
        const sampleTimer = setInterval(() => frameSamples.push({ elapsedMs: performance.now() - started,
          frame: player.current!.getCurrentFrame() }), 1000);
        await sleep(seconds * 1000);
        clearInterval(sampleTimer);
        const elapsedMs = performance.now() - started;
        const timelineFrame = player.current!.getCurrentFrame();
        player.current!.pause();
        capturePlayback = false;
        player.current!.removeEventListener('frameupdate', onFrame);
        let totalFrames = 0, droppedFrames = 0;
        for (const video of document.querySelectorAll('video')) {
          const after = video.getVideoPlaybackQuality(), prior = before.get(video);
          totalFrames += after.totalVideoFrames - (prior?.totalVideoFrames ?? 0);
          droppedFrames += after.droppedVideoFrames - (prior?.droppedVideoFrames ?? 0);
        }
        const advancedFrames = timelineFrame - initialFrame;
        return { elapsedMs, startedAt: started, requestedStartFrame: startFrame, warmupSeconds, initialFrame, timelineFrame, advancedFrames,
          firstAdvanceMs, frameSamples, canvasDraws: playbackDraws,
          wallClockExpectedFrames: Math.floor(elapsedMs * state.fps / 1000),
          timelineShortfallFrames: Math.max(0, Math.floor(elapsedMs * state.fps / 1000) - advancedFrames),
          shortfallScope: warmupSeconds ? 'sample after continuous warmup; end minus actual initial frame; not a presentation metric'
            : 'includes post-seek buffering; end minus actual initial frame; not a presentation metric',
          skippedTimelineFrames, totalFrames: totalFrames || null, droppedFrames: totalFrames ? droppedFrames : null,
          droppedFrameScope: 'HTML5 fallback only; WebCodecs canvas has no native dropped-frame counter. Timeline skips are reported separately.',
          memory: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
          memoryScope: 'browser JS heap only, excludes native decoding/GPU' };
      },
      export: async (name: string, timeoutMs: number) => {
        const state = getState();
        player.current?.pause();
        let lastProgressReport = 0;
        const options = { state, codec: 'h264' as const, resolution: '1080p' as const, fps: state.fps, signal: AbortSignal.timeout(timeoutMs),
          onProgress: (progress: import('@remotion/web-renderer').RenderMediaOnWebProgress) => {
            if (performance.now() - lastProgressReport > 60000) {
              lastProgressReport = performance.now();
              console.info(`[benchmark-export] ${name} ${JSON.stringify(progress)}`);
            }
          } };
        const capability = await inspectBrowserExport(options);
        if (capability.status !== 'supported') return capability;
        const started = performance.now();
        const result = await renderTimelineInBrowser(options);
        if (result.status !== 'rendered') return result;
        const response = await fetch(`/__benchmark/output/${name}-webcodecs.mp4`, { method: 'POST', body: result.blob });
        if (!response.ok) throw new Error(`Writing browser export failed: ${response.status}`);
        return { status: 'rendered', elapsedMs: performance.now() - started, bytes: result.blob.size, capability };
      },
  };
}

declare global {
  interface Window { longVideoBench: {
    load: (state: TimelineState, mode: 'original' | 'proxy') => void;
    status: () => unknown;
    retrySource: (src: string) => Promise<void>;
    seek: (frame: number, observeOnly?: boolean) => Promise<unknown>;
    pointerAt?: (frame: number) => Promise<{ x: number; y: number }>;
    select?: (id: string | null) => void;
    flush?: () => Promise<{ originalUnchanged: boolean; scope: string }>;
    pendingSeek?: Promise<unknown>;
    playback: (seconds: number, options?: { startFrame?: number; warmupSeconds?: number }) => Promise<unknown>;
    export: (name: string, timeoutMs: number) => Promise<unknown>;
  }; }
}

