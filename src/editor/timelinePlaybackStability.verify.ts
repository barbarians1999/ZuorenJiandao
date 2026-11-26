import assert from 'node:assert/strict';
import {
  attachNativeMediaElementGuard,
  nativeAcceptableTimeShiftSeconds,
  withOpenEndedPreviewHash,
} from '../media/nativePlaybackGuard';
import { audioPlaybackWindows, selectActivePlayerAudioWindows } from './audioPlaybackWindow';
import { continuousVideoAudioGroups, sharedAudioVolume } from './transitionAudio';
import { isMatchingAudibleAudioElement, mediaUrlMatchesItemSrc } from '../components/timeline/usePlayheadPaint';
import type { TimelineItem } from './types';

// 1. Open-ended preview URL hash prevents Remotion #t=start,end early cutoffs.
assert.equal(withOpenEndedPreviewHash('/media/uploads/demo.mp4'), '/media/uploads/demo.mp4#preview');
assert.equal(
  withOpenEndedPreviewHash('/api/preview-proxy-file?src=%2Fmedia%2Fuploads%2F%E6%B5%8B%E8%AF%95.mp4&revision=1'),
  '/api/preview-proxy-file?src=%2Fmedia%2Fuploads%2F%E6%B5%8B%E8%AF%95.mp4&revision=1#preview',
);
assert.equal(withOpenEndedPreviewHash('/media/uploads/demo.mp4#t=0,5'), '/media/uploads/demo.mp4#t=0,5');
assert.equal(withOpenEndedPreviewHash('data:audio/mp3;base64,abc'), 'data:audio/mp3;base64,abc');

// 2. Acceptable time-shift headroom scales with playback rate and never drops below 2.2s.
assert.equal(nativeAcceptableTimeShiftSeconds(1, 1), 2.2);
assert.equal(nativeAcceptableTimeShiftSeconds(0.5, 1), 2.2);
assert.ok(Math.abs(nativeAcceptableTimeShiftSeconds(1.5, 1) - 3.3) < 1e-9);
assert.equal(nativeAcceptableTimeShiftSeconds(2, 2), 8.8);

// 3. Native media element guard upgrades preload and coalesces readyState===0 seeks.
{
  let nativeCurrentTime = 0;
  let nativeSetCalls = 0;

  class MockMediaElement {
    readyState = 0;
    duration = 120;
    preload = 'metadata';
    src = '/media/uploads/test.mp4';
    currentSrc = '/media/uploads/test.mp4';
    private readonly listeners = new Map<string, Set<() => void>>();

    get currentTime(): number {
      return nativeCurrentTime;
    }

    set currentTime(value: number) {
      nativeSetCalls += 1;
      nativeCurrentTime = value;
    }

    addEventListener(type: string, fn: () => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }

    removeEventListener(type: string, fn: () => void) {
      this.listeners.get(type)?.delete(fn);
    }

    emit(type: string) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) {
        fn();
      }
    }
  }

  const mockEl = new MockMediaElement();
  const el = mockEl as unknown as HTMLMediaElement;
  attachNativeMediaElementGuard(el);
  attachNativeMediaElementGuard(el); // idempotent

  assert.equal(el.preload, 'auto', 'metadata preload upgrades to auto for real media sources');

  for (let i = 0; i < 30; i += 1) {
    el.currentTime = 45 + i * 0.033;
  }
  assert.equal(nativeSetCalls, 1, '30 rapid readyState===0 writes only issue 1 initial native seek');
  assert.ok(Math.abs(el.currentTime - (45 + 29 * 0.033)) < 1e-6, 'getter exposes latest pending seek while unloaded');

  // Simulate metadata arrival where Chromium had kept nativeCurrentTime at 0.
  nativeCurrentTime = 0;
  mockEl.readyState = 1;
  mockEl.emit('loadedmetadata');
  assert.equal(nativeSetCalls, 2, 'loadedmetadata applies the coalesced seek once');
  assert.ok(Math.abs(nativeCurrentTime - (45 + 29 * 0.033)) < 1e-6);

  // Subsequent normal seeks pass directly through.
  el.currentTime = 47;
  assert.equal(nativeSetCalls, 3);
  assert.equal(nativeCurrentTime, 47);

  // Shared-audio tag reuse resets via loadstart.
  mockEl.readyState = 0;
  mockEl.preload = 'metadata';
  mockEl.src = '/media/uploads/next.mp3';
  mockEl.currentSrc = '/media/uploads/next.mp3';
  mockEl.emit('loadstart');
  assert.equal(el.preload, 'auto');
  el.currentTime = 12;
  assert.equal(nativeSetCalls, 4);
  assert.equal(el.currentTime, 12);
}

// 4. Dense audio premount windows are capped so shared audio tags never exceed 32.
{
  const denseAudio: TimelineItem[] = Array.from({ length: 50 }, (_, idx) => ({
    id: `cut-${idx}`,
    name: `cut-${idx}`,
    kind: 'audio',
    track: 'A1',
    startFrame: idx * 3,
    durationInFrames: 3,
    src: '/media/uploads/speech.wav',
    srcInFrame: idx * 5,
  }));
  const windows = audioPlaybackWindows(denseAudio, denseAudio, [], undefined, 30, 30);
  const selected = selectActivePlayerAudioWindows(windows, 30, 6);
  const activeCount = selected.filter((w) => 30 >= w.activeFrom && 30 < w.to).length;
  const premountCount = selected.filter((w) => 30 < w.activeFrom).length;
  assert.equal(activeCount, 1, 'currently playing clip is always mounted');
  assert.ok(premountCount <= 6, `premount neighbors capped (${premountCount} <= 6)`);
  assert.ok(selected.length <= 7, 'total mounted tags stay well below 32');
}

// 5. Chinese filename matching & shared-slot disambiguation reject wrong cuts and <video> tags.
{
  assert.equal(
    mediaUrlMatchesItemSrc(
      'http://127.0.0.1:5199/media/uploads/%E8%A1%A1%E6%B0%B43-%E5%8E%9F%E5%A3%B0.wav#preview',
      '/media/uploads/衡水3-原声.wav',
    ),
    true,
  );
  assert.equal(
    mediaUrlMatchesItemSrc(
      'http://127.0.0.1:5199/api/preview-proxy-file?src=%2Fmedia%2Fuploads%2F%E6%B5%8B%E8%AF%95.mp4&revision=42#preview',
      '/media/uploads/测试.mp4',
    ),
    true,
  );
  assert.equal(mediaUrlMatchesItemSrc('data:audio/mp3;base64,xyz', '/media/uploads/a.mp3'), false);

  const item = {
    startFrame: 300,
    durationInFrames: 90,
    playbackRate: 1,
    srcInFrame: 600,
    src: '/media/uploads/中文配音.wav',
  };
  assert.equal(
    isMatchingAudibleAudioElement({
      tagName: 'VIDEO',
      paused: false,
      muted: false,
      seeking: false,
      readyState: 4,
      currentTime: 21,
      currentSrc: 'http://127.0.0.1:5199/media/uploads/%E4%B8%AD%E6%96%87%E9%85%8D%E9%9F%B3.wav',
      src: '/media/uploads/中文配音.wav',
    }, item, 30),
    false,
    'never match a <video> tag for audio clock sync',
  );
  assert.equal(
    isMatchingAudibleAudioElement({
      tagName: 'AUDIO',
      paused: false,
      muted: false,
      seeking: false,
      readyState: 4,
      currentTime: 5, // corresponds to frame -150, way outside [300..390]
      currentSrc: 'http://127.0.0.1:5199/media/uploads/%E4%B8%AD%E6%96%87%E9%85%8D%E9%9F%B3.wav',
      src: '/media/uploads/中文配音.wav',
    }, item, 30),
    false,
    'reject another shared <audio> tag from an earlier cut of the same file',
  );
  assert.equal(
    isMatchingAudibleAudioElement({
      tagName: 'AUDIO',
      paused: false,
      muted: false,
      seeking: false,
      readyState: 4,
      currentTime: 21, // sourceFrame 630 -> timelineFrame 330 (inside [300..390])
      currentSrc: 'http://127.0.0.1:5199/media/uploads/%E4%B8%AD%E6%96%87%E9%85%8D%E9%9F%B3.wav',
      src: '/media/uploads/中文配音.wav',
    }, item, 30),
    true,
    'matches the exact active <audio> tag for percent-encoded Chinese filenames',
  );
}

// 6. sharedAudioVolume & canShareAudio honor audioDetached and positive volume keyframes.
{
  const detachedPair: TimelineItem[] = [
    {
      id: 'v1', name: 'v1', kind: 'video', track: 'V1',
      startFrame: 0, durationInFrames: 60, src: '/a.mp4', srcInFrame: 0,
      audioDetached: true, volume: 0,
    },
    {
      id: 'v2', name: 'v2', kind: 'video', track: 'V1',
      startFrame: 60, durationInFrames: 60, src: '/a.mp4', srcInFrame: 60,
      audioDetached: false, volume: 1,
    },
  ];
  assert.equal(
    continuousVideoAudioGroups(detachedPair).length,
    0,
    'detached video clip must not share an audio group with an attached sibling',
  );
  assert.equal(
    sharedAudioVolume([detachedPair[0]!], false, () => 1),
    0,
    'audioDetached clip produces zero shared audio volume',
  );

  const keyframedSilentStart: TimelineItem = {
    id: 'v3', name: 'v3', kind: 'video', track: 'V1',
    startFrame: 0, durationInFrames: 60, src: '/a.mp4', srcInFrame: 0,
    volume: 0, keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] },
  };
  const volFn = sharedAudioVolume([keyframedSilentStart], false, () => 1);
  assert.equal(typeof volFn, 'function', 'volume:0 with positive keyframes stays audible');
  assert.equal((volFn as (f: number) => number)(30), 1);
}

console.log('timelinePlaybackStability.verify: all playback stability regressions passed');
