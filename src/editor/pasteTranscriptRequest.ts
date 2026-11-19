export function nextPasteTranscriptRequest(current: number): number {
  return Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
}
