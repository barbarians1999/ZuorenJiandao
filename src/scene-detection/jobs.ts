import type { SceneChange } from './detect.ts';

export type SceneDetectionJobStatus =
  | 'queued'
  | 'probing'
  | 'detecting'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SceneEvidence extends SceneChange {
  beforeTimeMs: number;
  afterTimeMs: number;
  beforeThumbnailUrl: string;
  afterThumbnailUrl: string;
}

export interface SceneDetectionResult {
  durationMs: number;
  /** Source-media bounds; omitted in historical responses that scanned the full file. */
  rangeStartMs?: number;
  rangeEndMs?: number;
  threshold: number;
  minSceneMs: number;
  sampleFps: number;
  scenes: SceneEvidence[];
}

export interface SceneDetectionJobSnapshot {
  id: string;
  src: string;
  status: SceneDetectionJobStatus;
  progress: number;
  processedMs: number;
  createdAt: number;
  updatedAt: number;
  result: SceneDetectionResult | null;
  error: string | null;
}

export interface StartSceneDetectionOptions {
  src: string;
  rangeStartMs?: number;
  rangeEndMs?: number;
  threshold?: number;
  minSceneMs?: number;
  maxScenes?: number;
}

async function readJobResponse(response: Response): Promise<SceneDetectionJobSnapshot> {
  const body = (await response.json().catch(() => ({}))) as SceneDetectionJobSnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `scene detection request failed (${response.status})`);
  return body;
}

export async function startSceneDetectionJob(options: StartSceneDetectionOptions): Promise<SceneDetectionJobSnapshot> {
  const response = await fetch('/api/detect-scenes/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
  return readJobResponse(response);
}

export async function getSceneDetectionJob(id: string): Promise<SceneDetectionJobSnapshot> {
  return readJobResponse(await fetch(`/api/detect-scenes/jobs/${encodeURIComponent(id)}`));
}

export async function cancelSceneDetectionJob(id: string): Promise<SceneDetectionJobSnapshot> {
  return readJobResponse(await fetch(`/api/detect-scenes/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}
