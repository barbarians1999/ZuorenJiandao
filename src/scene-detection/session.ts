import { cancelSceneDetectionJob, startSceneDetectionJob, type SceneDetectionJobSnapshot,
  type StartSceneDetectionOptions } from './jobs';

export const sceneJobActive = (job: SceneDetectionJobSnapshot | null): boolean => !!job
  && ['queued', 'probing', 'detecting', 'finalizing'].includes(job.status);

/** A cancelled/closed dialog still owns a creation response that arrives later. */
export class SceneDetectionSession {
  private generation = 0;
  private pending = false;
  private closed = false;
  private current: SceneDetectionJobSnapshot | null = null;
  private readonly create: typeof startSceneDetectionJob;
  private readonly abort: typeof cancelSceneDetectionJob;
  constructor(create = startSceneDetectionJob, abort = cancelSceneDetectionJob) {
    this.create = create;
    this.abort = abort;
  }
  get isClosed() { return this.closed; }
  get isPending() { return this.pending; }
  get snapshot() { return this.current; }

  async start(options: StartSceneDetectionOptions): Promise<SceneDetectionJobSnapshot | null> {
    if (this.closed) throw new Error('检测窗口已关闭');
    if (this.pending || sceneJobActive(this.current)) throw new Error('已有检测正在进行');
    const generation = ++this.generation;
    this.pending = true;
    try {
      const job = await this.create(options);
      if (this.closed || generation !== this.generation) {
        if (sceneJobActive(job)) {
          try { await this.abort(job.id); }
          catch (error) { this.current = job; throw error; }
        }
        return null;
      }
      this.current = job;
      return job;
    } finally { this.pending = false; }
  }
  accept(job: SceneDetectionJobSnapshot): boolean {
    if (this.closed || job.id !== this.current?.id) return false;
    if (this.current.status === 'cancelled' && job.status !== 'cancelled') return false;
    this.current = job;
    return true;
  }
  async cancel(): Promise<SceneDetectionJobSnapshot | null> {
    const generation = ++this.generation;
    const job = this.current;
    if (!sceneJobActive(job)) return null;
    const next = await this.abort(job!.id);
    if (generation !== this.generation || this.closed) return null;
    this.current = next;
    return next;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    if (sceneJobActive(this.current)) await this.abort(this.current!.id);
  }
}
