export function seekSchedule(durationFrames: number, fps: number): number[];
export function latencySummary(results: readonly { status: string; elapsedMs: number }[]): {
  medianMs: number | null; p95Ms: number | null; failed: number;
};
export function dissolveBarcode(outgoing: number, incoming: number, progress: number): number[];
export function matchDissolveFrames(bits: number[], outgoing: number, incoming: number, progress: number):
  { outgoingDelta: number; incomingDelta: number; exact: boolean } | null;
export function barcodeMatches(first: number[], second: number[]): boolean;
export function pulseStarts(samples: number[], threshold: number, sampleRate: number): number[];
