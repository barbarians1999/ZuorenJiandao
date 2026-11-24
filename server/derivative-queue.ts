const DEFAULT_DERIVATIVE_CONCURRENCY = 2;
export const MAX_DERIVATIVE_CONCURRENCY = 4;

export type DerivativePriority = 'high' | 'normal' | 'low';
export type DerivativeWork<T> = (signal: AbortSignal) => Promise<T>;

export interface DerivativeAcquireOptions {
  priority?: DerivativePriority;
}

export interface DerivativeLease<T> {
  promise: Promise<T>;
  release: () => void;
}

type JobState = 'queued' | 'running' | 'done';

const PRIORITY_RANK: Record<DerivativePriority, number> = {
  high: 2,
  normal: 1,
  low: 0,
};

interface Job<T> {
  key: string;
  state: JobState;
  priority: DerivativePriority;
  seq: number;
  consumers: number;
  controller: AbortController;
  work: DerivativeWork<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function configuredConcurrency(value = process.env.OPENCHATCUT_DERIVATIVE_CONCURRENCY): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DERIVATIVE_CONCURRENCY;
  return Math.max(1, Math.min(MAX_DERIVATIVE_CONCURRENCY, parsed));
}

function cancellationError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

export class DerivativeQueue {
  readonly concurrency: number;
  private readonly jobs = new Map<string, Job<unknown>>();
  private readonly pending: Job<unknown>[] = [];
  private active = 0;
  private lowPriorityRunning = false;
  private nextSeq = 0;

  constructor(concurrency = configuredConcurrency()) {
    const normalized = Number.isFinite(concurrency) ? Math.floor(concurrency) : DEFAULT_DERIVATIVE_CONCURRENCY;
    this.concurrency = Math.max(1, Math.min(MAX_DERIVATIVE_CONCURRENCY, normalized));
  }

  acquire<T>(
    key: string,
    work: DerivativeWork<T>,
    options: DerivativeAcquireOptions = {},
  ): DerivativeLease<T> {
    const priority = options.priority ?? 'normal';
    const running = this.jobs.get(key) as Job<T> | undefined;
    if (running && !running.controller.signal.aborted) {
      running.consumers += 1;
      if (running.state === 'queued' && PRIORITY_RANK[priority] > PRIORITY_RANK[running.priority]) {
        running.priority = priority;
        this.pump();
      }
      return this.lease(running);
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    const job: Job<T> = {
      key, state: 'queued', priority, seq: this.nextSeq++, consumers: 1, controller: new AbortController(),
      work, promise, resolve, reject,
    };
    this.jobs.set(key, job as Job<unknown>);
    this.pending.push(job as Job<unknown>);
    this.pump();
    return this.lease(job);
  }

  private lease<T>(job: Job<T>): DerivativeLease<T> {
    let released = false;
    return {
      promise: job.promise,
      release: () => {
        if (released) return;
        released = true;
        this.release(job as Job<unknown>);
      },
    };
  }

  private release(job: Job<unknown>): void {
    job.consumers = Math.max(0, job.consumers - 1);
    if (job.consumers || job.state === 'done') return;
    if (job.state === 'running') {
      job.controller.abort();
      return;
    }
    const index = this.pending.indexOf(job);
    if (index >= 0) this.pending.splice(index, 1);
    job.state = 'done';
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.reject(cancellationError());
  }

  private nextEligibleIndex(): number {
    let bestIndex = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const candidate = this.pending[i]!;
      if (candidate.state !== 'queued') continue;
      // A second waveform or filmstrip must leave room for proxies and stills.
      if (candidate.priority === 'low' && this.lowPriorityRunning) continue;
      if (bestIndex < 0) {
        bestIndex = i;
        continue;
      }
      const best = this.pending[bestIndex]!;
      const rankDiff = PRIORITY_RANK[candidate.priority] - PRIORITY_RANK[best.priority];
      if (rankDiff > 0 || (rankDiff === 0 && candidate.seq < best.seq)) {
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const index = this.nextEligibleIndex();
      if (index < 0) return;
      const [job] = this.pending.splice(index, 1);
      if (!job || job.state !== 'queued') continue;
      this.start(job);
    }
  }

  private start(job: Job<unknown>): void {
    job.state = 'running';
    this.active += 1;
    const isLow = job.priority === 'low';
    if (isLow) this.lowPriorityRunning = true;
    void Promise.resolve()
      .then(() => job.work(job.controller.signal))
      .then(job.resolve, job.reject)
      .finally(() => {
        job.state = 'done';
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active -= 1;
        if (isLow) this.lowPriorityRunning = false;
        this.pump();
      });
  }
}

export const derivativeQueue = new DerivativeQueue();
