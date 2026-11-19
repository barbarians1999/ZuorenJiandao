export interface IsolatedRenderJob {
  bundle: string;
  media: string;
  browser: string;
  options: Record<string, unknown>;
}
export function isolatedTimelineRender(job: IsolatedRenderJob, callbacks?: {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  onLog?: (line: string) => void;
}): Promise<{ outputLocation: string }>;
