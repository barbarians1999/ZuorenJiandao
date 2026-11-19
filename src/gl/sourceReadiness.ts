interface VideoPosition {
  readyState: number;
  seeking: boolean;
  currentTime: number;
  duration: number;
}

/** Readiness alone can still describe the previously decoded seek position. */
export function videoReadyAtFrame(video: VideoPosition, sourceFrame: number, fps: number): boolean {
  const rate = Math.max(1, fps);
  const target = Math.max(0, Math.min(sourceFrame / rate,
    Number.isFinite(video.duration) ? Math.max(0, video.duration - 1 / rate) : Infinity));
  return video.readyState >= 2 && !video.seeking
    && Math.abs(video.currentTime - target) < 0.5 / rate + 1e-6;
}
