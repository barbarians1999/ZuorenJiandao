export interface GifTiming {
  width?: number;
  height?: number;
  frameCount: number;
  delaysMs: number[];
  cumulativeMs: number[];
  totalDurationMs: number;
  /** 0 = infinite loop; >= 1 = finite number of passes before holding last frame. */
  loopCount: number;
}

export function parseGifTiming(input: Uint8Array | ArrayBuffer | ArrayBufferView): GifTiming;
export function gifFrameIndexAtTimeMs(timing: GifTiming, timeMs: number): number;
