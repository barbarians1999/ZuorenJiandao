import { makeCancelSignal, RenderInternals } from '@remotion/renderer';
import { resolveRenderConcurrency } from './performance.mjs';

// Runtime process settings shared by full renders, stills and direct encoding.
export const binariesDirectory = () => process.env.CC_REMOTION_BINARIES_DIR || null;

export function currentRenderConcurrency() {
  return resolveRenderConcurrency();
}

export function remotionFfmpegPath() {
  return RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: binariesDirectory(),
  });
}

export function remotionCancelSignal(signal) {
  if (!signal) return undefined;
  const cancellation = makeCancelSignal();
  if (signal.aborted) cancellation.cancel();
  else signal.addEventListener('abort', cancellation.cancel, { once: true });
  return cancellation.cancelSignal;
}
