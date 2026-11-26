/**
 * Pure GIF87a / GIF89a frame-delay and timeline frame-index utilities.
 * Shared cleanly between browser playback/rendering (`<SyncedGif>`) and Node verification.
 */

const DEFAULT_GIF_FRAME_DELAY_MS = 100;

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(0);
}

function asciiAt(bytes, start, len) {
  if (start + len > bytes.length) return '';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += String.fromCharCode(bytes[start + i]);
  }
  return out;
}

function skipSubBlocks(bytes, pos) {
  let cursor = pos;
  while (cursor < bytes.length) {
    const size = bytes[cursor];
    cursor += 1;
    if (size === 0) break;
    cursor = Math.min(bytes.length, cursor + size);
  }
  return cursor;
}

/**
 * Parse frame count, per-frame millisecond delays, and Netscape loop behavior
 * from raw GIF87a/GIF89a bytes without throwing on truncated files.
 */
export function parseGifTiming(input) {
  const bytes = toUint8Array(input);
  const fallback = {
    frameCount: 1,
    delaysMs: [DEFAULT_GIF_FRAME_DELAY_MS],
    cumulativeMs: [0],
    totalDurationMs: DEFAULT_GIF_FRAME_DELAY_MS,
    loopCount: 0,
  };
  if (bytes.length < 14) return fallback;
  const header = asciiAt(bytes, 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return fallback;

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const lsdPacked = bytes[10];
  let pos = 13;
  if ((lsdPacked & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((lsdPacked & 0x07) + 1));
    pos = Math.min(bytes.length, pos + gctSize);
  }

  const delaysMs = [];
  let pendingDelayMs = null;
  let hasLoopExtension = false;
  let parsedLoopCount = 0;

  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3B) break; // Trailer
    if (block === 0x21) {
      if (pos + 2 >= bytes.length) break;
      const label = bytes[pos + 1];
      if (label === 0xF9 && pos + 6 < bytes.length && bytes[pos + 2] >= 4) {
        const delayCs = bytes[pos + 4] | (bytes[pos + 5] << 8);
        // Chromium / FFmpeg GIF spec normalizes 0cs / 1cs (< 20ms) frames to 100ms.
        pendingDelayMs = delayCs <= 1 ? DEFAULT_GIF_FRAME_DELAY_MS : delayCs * 10;
        pos = skipSubBlocks(bytes, pos + 2);
      } else if (label === 0xFF && pos + 14 < bytes.length && bytes[pos + 2] === 11) {
        const appId = asciiAt(bytes, pos + 3, 11);
        let subPos = pos + 14;
        if ((appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0')
          && subPos + 3 < bytes.length
          && bytes[subPos] >= 3
          && bytes[subPos + 1] === 0x01) {
          hasLoopExtension = true;
          parsedLoopCount = bytes[subPos + 2] | (bytes[subPos + 3] << 8);
        }
        pos = skipSubBlocks(bytes, pos + 2);
      } else {
        pos = skipSubBlocks(bytes, pos + 2);
      }
      continue;
    }
    if (block === 0x2C) {
      if (pos + 10 > bytes.length) break;
      const idPacked = bytes[pos + 9];
      pos += 10;
      if ((idPacked & 0x80) !== 0) {
        const lctSize = 3 * (1 << ((idPacked & 0x07) + 1));
        pos = Math.min(bytes.length, pos + lctSize);
      }
      if (pos >= bytes.length) break;
      pos += 1; // LZW minimum code size
      pos = skipSubBlocks(bytes, pos);
      delaysMs.push(pendingDelayMs ?? DEFAULT_GIF_FRAME_DELAY_MS);
      pendingDelayMs = null;
      continue;
    }
    pos += 1;
  }

  if (delaysMs.length === 0) return { ...fallback, width, height };
  const cumulativeMs = [];
  let totalDurationMs = 0;
  for (const d of delaysMs) {
    cumulativeMs.push(totalDurationMs);
    totalDurationMs += Math.max(1, d);
  }
  const loopCount = delaysMs.length <= 1
    ? 1
    : hasLoopExtension
      ? parsedLoopCount
      : 1;
  return {
    width,
    height,
    frameCount: delaysMs.length,
    delaysMs,
    cumulativeMs,
    totalDurationMs: Math.max(1, totalDurationMs),
    loopCount,
  };
}

/**
 * Resolve the exact GIF frame index active at `timeMs` (timeline/source clock in milliseconds).
 */
export function gifFrameIndexAtTimeMs(timing, timeMs) {
  const count = timing?.frameCount ?? 0;
  if (count <= 1) return 0;
  const total = Math.max(1, timing.totalDurationMs ?? DEFAULT_GIF_FRAME_DELAY_MS);
  const t = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
  const loopCount = timing.loopCount ?? 0;

  let localMs;
  if (loopCount === 0) {
    localMs = t % total;
  } else {
    // Wait: NETSCAPE2.0 loopCount=0 is infinite; loopCount=N>0 repeats N times after initial play (N+1) OR no-ext=1 play.
    // Standard single-pass when loopCount === 1 & no extension -> 1 pass; >=1 extension means total passes.
    if (t >= total * Math.max(1, loopCount)) return count - 1;
    localMs = t % total;
  }

  const cumulative = timing.cumulativeMs ?? [];
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cumulative[mid] ?? 0) <= localMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
