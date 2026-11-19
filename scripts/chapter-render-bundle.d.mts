export function chapterSourceDigest(root?: string): Promise<string>;
export function validateChapterBundle(manifest: {version: number; sourceDigest: string}, digest: string): void;
export function prepareChapterBundle(options: {
  output?: string; reuse?: string;
  build?: (output?: string) => Promise<string>;
  signal: AbortSignal; existingOnly?: boolean;
}): Promise<{directory: string; sourceDigest: string; reused: boolean; clonedFrom?: string}>;
