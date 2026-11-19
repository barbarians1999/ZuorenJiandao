import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import { createArtifactExporters } from './artifactExportOperations';
import type { ExportDestination } from './exportDestination';
import { createExportRunner } from './exportRunOperation';
import type {
  ExportProgress,
  ExportTab,
  UseExportWorkflowOptions,
  WorkflowOperations,
} from './exportWorkflowTypes';
import { createExportJobStore, initialViewedExportJobId } from './backgroundExportStore';
import { notifyAgentExportSubmitted, subscribeAgentExportJobs } from './agentExportTracking';
import { exportEtaMs, exportProgressFillRatio, formatExportDuration, formatProgressPercent } from './ExportDialogFooter';
import { browserProgress, type VideoExportContext } from './videoExportOperation';
const etaBase: ExportProgress = { phase: 'rendering', percent: 50, startedAt: 1_000, totalFrames: 100, processedFrames: 50 };
assert.equal(exportEtaMs({ ...etaBase, phase: 'queued' }, 30_000), null, 'queued time is excluded from ETA');
assert.equal(exportEtaMs(etaBase, 1_999), null, 'ETA waits for a rendering sample');
assert.equal(exportEtaMs(etaBase, 10_000), 10_000, 'ETA uses elapsed render time');
assert.equal(exportEtaMs({ ...etaBase, phase: 'finalizing' }, 30_000), null, 'finalizing has no frame ETA');
{
  let current: ExportProgress = { phase: 'preparing', percent: 0, startedAt: 1_000 };
  const report = browserProgress({
    options: { state: { fps: 30, items: [{ startFrame: 0, durationInFrames: 300 }] }, fps: 60 },
    setBusy() {}, setRenderEngine() {}, t: (key: string) => key,
    setProgress: (update: ExportProgress | null | ((previous: ExportProgress | null) => ExportProgress | null)) => {
      current = (typeof update === 'function' ? update(current) : update)!;
    },
  } as unknown as VideoExportContext);
  report({ progress: .5, encodedFrames: 300 } as Parameters<typeof report>[0]);
  assert.equal(current.totalFrames, 600, 'browser progress counts output frames after FPS conversion');
  assert.equal(exportProgressFillRatio(current), .5);
  assert.ok(current.renderingStartedAt !== undefined, 'browser rendering starts the ETA sampling clock');
  assert.equal(exportEtaMs(current, 10_000), 10_000, 'browser ETA remains visible at halfway progress');
}
interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}


function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let now = 1_000;
const distinctTargets = createExportJobStore();
const pendingTarget = new Promise<void>(() => {});
const startTarget = (targetKey: string) => distinctTargets.start({
  label: 'same.mp4', targetPath: 'Exports/same.mp4', targetKey,
  execute: () => pendingTarget,
});
const targetA = startTarget('grant-a/same.mp4');
assert.notEqual(startTarget('grant-b/same.mp4'), targetA,
  'same visible name in distinct granted directories must enqueue two jobs');
assert.equal(startTarget('grant-a/same.mp4'), targetA, 'same actual target still deduplicates');
const store = createExportJobStore(() => ++now);
const renderGate = deferred();
const finished = deferred();
let modalNotifications = 0;
const unmountModal = store.subscribe(() => { modalNotifications += 1; });

const jobId = store.start({
  label: 'project.mp4',
  targetPath: 'Exports/project.mp4',
  async execute({ setters }) {
    setters.setBusy('rendering');
    setters.setProgress((progress) => progress ? { ...progress, phase: 'rendering', percent: 25 } : progress);
    await renderGate.promise;
    setters.setProgress((progress) => progress ? {
      ...progress,
      phase: 'completed',
      percent: 100,
      finishedAt: now,
    } : progress);
    setters.setBusy(null);
    finished.resolve();
  },
});

let duplicateRuns = 0;
const duplicateId = store.start({
  label: 'project.mp4',
  targetPath: 'Exports/project.mp4',
  async execute() { duplicateRuns += 1; },
});
await Promise.resolve();
assert.equal(duplicateId, jobId, 'an active target reuses its existing export job');
assert.equal(duplicateRuns, 0, 'rapid duplicate starts do not launch a second render');

assert.equal(store.getSnapshot().jobs[0]?.id, jobId);
assert.equal(initialViewedExportJobId(store.getSnapshot().jobs), jobId, 'reopening resumes the active export');
unmountModal();
const notificationsAtUnmount = modalNotifications;
renderGate.resolve();
await finished.promise;
const completed = store.getSnapshot().jobs.find((job) => job.id === jobId);
assert.equal(completed?.progress.phase, 'completed');
assert.equal(completed?.busy, null);
assert.equal(initialViewedExportJobId(store.getSnapshot().jobs), null, 'completed history must not trap reopening on the Done button');
assert.equal(modalNotifications, notificationsAtUnmount, 'unmounted modal receives no updates');
assert.equal(store.getSnapshot().jobs.length, 1, 'job state belongs to the editor store, not the modal subscription');

const cancelled = deferred();
const cancelledId = store.start({
  label: 'cancelled.mp4',
  targetPath: 'Exports/cancelled.mp4',
  async execute({ signal, setters }) {
    try {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } finally {
      setters.setProgress((progress) => progress ? { ...progress, phase: 'rendering', percent: 90 } : progress);
      setters.setProgress((progress) => progress ? {
        ...progress,
        phase: 'completed',
        percent: 100,
        finishedAt: now,
      } : progress);
      setters.setBusy(null);
      cancelled.resolve();
    }
  },
});
await Promise.resolve();
assert.equal(store.cancel(cancelledId), true);
await cancelled.promise;
await Promise.resolve();
const cancelledJob = store.getSnapshot().jobs.find((job) => job.id === cancelledId);
assert.equal(cancelledJob?.progress.phase, 'cancelled');
assert.equal(cancelledJob?.busy, null, 'terminal jobs still permit busy cleanup');

const mgItem = {
  id: 'mg-1',
  name: 'Title',
  kind: 'text',
  startFrame: 0,
  durationInFrames: 30,
  props: { text: 'Title' },
} as unknown as TimelineItem;
const timelineState = {
  fps: 30,
  items: [],
  transitions: [],
  markers: [],
} as unknown as TimelineState;
const subtitleCaptions = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  words: [{ text: 'hello', start: 0, end: 500 }],
} satisfies CaptionsData;

function workflowOptions(tab: ExportTab): UseExportWorkflowOptions {
  return {
    state: timelineState,
    projectId: 'project-lifecycle',
    projectName: 'Lifecycle',
    base: `lifecycle-${tab}`,
    tab,
    codec: 'h264',
    resolution: '1080p',
    fps: 30,
    subtitleFormat: 'srt',
    subtitleCaptions,
    nleFormat: 'fcp_xml',
    includeMg: tab === 'xml',
    mgItems: tab === 'mg' || tab === 'xml' ? [mgItem] : [],
    onClose: () => undefined,
  };
}

function startArtifactExport(
  tab: Extract<ExportTab, 'mg' | 'subtitles' | 'xml'>,
  destination: ExportDestination,
  done: Deferred,
): string {
  const options = workflowOptions(tab);
  return store.start({
    label: `lifecycle-${tab}`,
    targetPath: `Exports/lifecycle-${tab}`,
    async execute({ signal, setters }) {
      const artifacts = createArtifactExporters({
        destination,
        beginTargetCommit: setters.beginTargetCommit,
        endTargetCommit: setters.endTargetCommit,
        markTargetCommitted: setters.markTargetCommitted,
        options,
        setBusy: setters.setBusy,
        setProgress: setters.setProgress,
        t: (key) => key,
      });
      const idle = async () => undefined;
      const operations: WorkflowOperations = {
        exportAudio: idle,
        exportMg: (ownerSignal) => artifacts.exportMg(ownerSignal),
        exportSubtitles: (ownerSignal) => artifacts.exportSubtitles(ownerSignal),
        exportVideo: idle,
        exportXml: (ownerSignal) => artifacts.exportXml(ownerSignal),
      };
      const run = createExportRunner({
        busy: null,
        operations,
        options,
        prepareDestination: async () => undefined,
        progress: null,
        signal,
        targetPath: `Exports/lifecycle-${tab}`,
        t: (key) => key,
        ...setters,
      });
      try {
        await run();
      } finally {
        done.resolve();
      }
    },
  });
}

function directoryDestination(
  queryPermission: () => Promise<'granted'>,
  onWrite: (value: Blob | BufferSource | string) => Promise<void>,
): ExportDestination {
  return {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission,
      requestPermission: async () => 'granted',
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: onWrite,
          close: async () => undefined,
        }),
      }),
    },
  };
}

async function verifyCancelledRenderedArtifact(
  tab: Extract<ExportTab, 'mg' | 'xml'>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const renderStarted = deferred();
  const done = deferred();
  let targetWrites = 0;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/render-clip');
    renderStarted.resolve();
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const destination = directoryDestination(
      async () => 'granted',
      async () => { targetWrites += 1; },
    );
    const id = startArtifactExport(tab, destination, done);
    await renderStarted.promise;
    assert.equal(store.cancel(id), true);
    await done.promise;
    await Promise.resolve();
    const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
    assert.equal(targetWrites, 0, `${tab} cancellation must not write the target`);
    assert.equal(job?.progress.phase, 'cancelled');
    assert.notEqual(job?.progress.phase, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyCancelledSubtitleArtifact(): Promise<void> {
  const permissionStarted = deferred();
  const permissionGate = deferred();
  const done = deferred();
  let targetWrites = 0;
  const destination = directoryDestination(
    async () => {
      permissionStarted.resolve();
      await permissionGate.promise;
      return 'granted';
    },
    async () => { targetWrites += 1; },
  );
  const id = startArtifactExport('subtitles', destination, done);
  await permissionStarted.promise;
  assert.equal(store.cancel(id), true);
  permissionGate.resolve();
  await done.promise;
  await Promise.resolve();
  const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
  assert.equal(targetWrites, 0, 'subtitle cancellation must not write the target');
  assert.equal(job?.progress.phase, 'cancelled');
  assert.notEqual(job?.progress.phase, 'completed');
}

async function verifyRunnerChecksAbortBeforeCompletion(): Promise<void> {
  const controller = new AbortController();
  const operationStarted = deferred();
  const operationGate = deferred();
  let progress: ExportProgress | null = null;
  const phases: ExportProgress['phase'][] = [];
  const setProgress = (value: ExportProgress | null | ((current: ExportProgress | null) => ExportProgress | null)) => {
    progress = typeof value === 'function' ? value(progress) : value;
    if (progress) phases.push(progress.phase);
  };
  const idle = async () => undefined;
  const operations: WorkflowOperations = {
    exportAudio: idle,
    exportMg: async () => {
      operationStarted.resolve();
      await operationGate.promise;
    },
    exportSubtitles: idle,
    exportVideo: idle,
    exportXml: idle,
  };
  const run = createExportRunner({
    busy: null,
    operations,
    options: workflowOptions('mg'),
    prepareDestination: async () => undefined,
    progress: null,
    signal: controller.signal,
    targetPath: 'Exports/lifecycle-mg',
    t: (key) => key,
    setBusy: () => undefined,
    setClock: () => undefined,
    setError: () => undefined,
    setFailure: () => undefined,
    setProgress,
    setQa: () => undefined,
  });
  const running = run();
  await operationStarted.promise;
  controller.abort(new DOMException('cancelled', 'AbortError'));
  operationGate.resolve();
  await running;
  assert.equal(phases.at(-1), 'cancelled');
  assert.equal(phases.includes('completed'), false, 'aborted work cannot report completed');
}

async function verifyCommittedTargetWinsLateAbort(): Promise<void> {
  const controller = new AbortController();
  const phases: ExportProgress['phase'][] = [];
  let progress: ExportProgress | null = null;
  const setProgress = (value: ExportProgress | null | ((current: ExportProgress | null) => ExportProgress | null)) => {
    progress = typeof value === 'function' ? value(progress) : value;
    if (progress) phases.push(progress.phase);
  };
  const committed = Object.freeze({ targetCommitted: true as const });
  const idle = async () => undefined;
  const operations: WorkflowOperations = {
    exportAudio: idle,
    exportMg: async () => {
      controller.abort(new DOMException('late cancellation', 'AbortError'));
      return committed;
    },
    exportSubtitles: idle,
    exportVideo: idle,
    exportXml: idle,
  };
  await createExportRunner({
    busy: null,
    operations,
    options: workflowOptions('mg'),
    prepareDestination: async () => undefined,
    progress: null,
    signal: controller.signal,
    targetPath: 'Exports/lifecycle-mg',
    t: (key) => key,
    setBusy: () => undefined,
    setClock: () => undefined,
    setError: () => undefined,
    setFailure: () => undefined,
    setProgress,
    setQa: () => undefined,
  })();
  assert.equal(phases.at(-1), 'completed', 'a committed target is never relabelled cancelled');
  assert.equal(phases.includes('cancelled'), false);
}

async function verifyNormalArtifactExport(): Promise<void> {
  const done = deferred();
  let targetWrites = 0;
  const destination = directoryDestination(
    async () => 'granted',
    async () => { targetWrites += 1; },
  );
  const id = startArtifactExport('subtitles', destination, done);
  await done.promise;
  await Promise.resolve();
  const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
  assert.equal(targetWrites, 1);
  assert.equal(job?.progress.phase, 'completed');
}

async function verifyTerminalProgressClearsTransientDetail(): Promise<void> {
  const runVideo = async (writeFailure?: Error) => {
    const videoStore = createExportJobStore();
    const terminal = deferred();
    let jobId = '';
    const unsubscribe = videoStore.subscribe(() => {
      const phase = videoStore.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.phase;
      if (phase === 'completed' || phase === 'failed') terminal.resolve();
    });
    jobId = videoStore.start({
      label: 'video.mp4',
      targetPath: 'Exports/video.mp4',
      async execute({ signal, setters }) {
        const idle = async () => undefined;
        const operations: WorkflowOperations = {
          exportAudio: idle,
          exportMg: idle,
          exportSubtitles: idle,
          exportVideo: async () => {
            setters.setProgress({
              phase: 'downloading',
              percent: 99,
              startedAt: 1_000,
              processedFrames: 240,
              totalFrames: 240,
              outputSize: 4_600_000,
              detail: '正在写入所选位置',
            });
            if (writeFailure) throw writeFailure;
            setters.beginTargetCommit();
            setters.markTargetCommitted();
            return { targetCommitted: true };
          },
          exportXml: idle,
        };
        await createExportRunner({
          busy: null,
          operations,
          options: workflowOptions('video'),
          prepareDestination: async () => undefined,
          progress: null,
          signal,
          targetPath: 'Exports/video.mp4',
          t: (key) => key,
          ...setters,
        })();
      },
    });
    await terminal.promise;
    unsubscribe();
    return videoStore.getSnapshot().jobs.find((job) => job.id === jobId)!;
  };

  const completed = await runVideo();
  assert.equal(completed.progress.phase, 'completed');
  assert.equal(completed.progress.detail, undefined, 'completed exports do not keep a write-in-progress detail');
  assert.equal(completed.progress.processedFrames, 240);
  assert.equal(completed.progress.totalFrames, 240);
  assert.equal(completed.progress.outputSize, 4_600_000);

  const reason = new Error('destination write failed: disk full');
  const failed = await runVideo(reason);
  assert.equal(failed.progress.phase, 'failed');
  assert.equal(failed.progress.detail, undefined, 'failed exports do not keep a write-in-progress detail');
  assert.equal(failed.progress.processedFrames, 240);
  assert.equal(failed.progress.totalFrames, 240);
  assert.equal(failed.progress.outputSize, 4_600_000);
  assert.equal(failed.error, reason.message);
  assert.equal(failed.failure?.message, reason.message, 'the destination failure remains visible as the actual cause');
}

async function verifyTerminalProgressPreservesMeaningfulDetail(): Promise<void> {
  const noteStore = createExportJobStore();
  const completed = deferred();
  let jobId = '';
  const unsubscribe = noteStore.subscribe(() => {
    if (noteStore.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.phase === 'completed') {
      completed.resolve();
    }
  });
  const detail = '动态图层渲染失败，XML 已保留占位';
  jobId = noteStore.start({
    label: 'project.xml',
    targetPath: 'Exports/project.xml',
    async execute({ setters }) {
      setters.setProgress({ phase: 'rendering', percent: 95, startedAt: 1_000, detail });
      setters.setProgress((current) => current ? {
        ...current,
        phase: 'completed',
        percent: 100,
        finishedAt: Date.now(),
      } : current);
    },
  });
  await completed.promise;
  unsubscribe();
  assert.equal(noteStore.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.detail, detail,
    'terminal normalization preserves a meaningful note from non-download phases');
}

async function verifyUnexpectedFailureClearsTransientDetail(): Promise<void> {
  const unexpectedStore = createExportJobStore();
  const failed = deferred();
  let jobId = '';
  const unsubscribe = unexpectedStore.subscribe(() => {
    if (unexpectedStore.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.phase === 'failed') {
      failed.resolve();
    }
  });
  jobId = unexpectedStore.start({
    label: 'unexpected.mp4',
    targetPath: 'Exports/unexpected.mp4',
    async execute({ setters }) {
      setters.setProgress({
        phase: 'downloading',
        percent: 99,
        startedAt: 1_000,
        outputSize: 4_600_000,
        detail: '正在写入所选位置',
      });
      throw new Error('unexpected destination failure');
    },
  });
  await failed.promise;
  unsubscribe();
  const job = unexpectedStore.getSnapshot().jobs.find((entry) => entry.id === jobId);
  assert.equal(job?.progress.detail, undefined);
  assert.equal(job?.progress.outputSize, 4_600_000);
  assert.equal(job?.error, 'unexpected destination failure');
  assert.equal(job?.failure?.message, 'unexpected destination failure');
}

async function verifyAgentExportTracking(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    const tracked = createExportJobStore();
    let finishRequest!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finishRequest = resolve; })) as typeof fetch;
    const unsubscribe = subscribeAgentExportJobs('project-agent', tracked, (key) => key);
    notifyAgentExportSubmitted({
      renderId: 'render-agent', projectId: 'project-agent', label: 'agent.mp4', createdAt: 1_000,
    });
    const completed = new Promise<void>((resolve) => {
      const stop = tracked.subscribe(() => {
        if (tracked.getSnapshot().jobs[0]?.progress.phase !== 'completed') return;
        stop();
        resolve();
      });
    });
    await Promise.resolve();
    assert.equal(tracked.getActiveCount(), 1);
    assert.equal(tracked.getSnapshot().jobs[0]?.label, 'agent.mp4');
    finishRequest(Response.json({
      id: 'render-agent', status: 'succeeded', progress: 100,
      result: { path: '/media/uploads/agent.mp4', name: 'agent.mp4', sizeBytes: 12 },
    }));
    await completed;
    assert.equal(tracked.getActiveCount(), 0);
    assert.equal(tracked.getSnapshot().jobs[0]?.progress.outputSize, 12);
    unsubscribe();

    let deleted = false;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = String(url).endsWith('/render-cancel');
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const unsubscribeCancel = subscribeAgentExportJobs('project-agent', tracked, (key) => key);
    notifyAgentExportSubmitted({
      renderId: 'render-cancel', projectId: 'project-agent', label: 'cancel.mp4', createdAt: 2_000,
    });
    await Promise.resolve();
    const jobId = tracked.getSnapshot().jobs.find((job) => job.label === 'cancel.mp4')?.id;
    assert.ok(jobId);
    assert.equal(tracked.cancel(jobId), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(deleted, true);
    assert.equal(tracked.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.phase, 'cancelled');
    unsubscribeCancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await verifyCancelledRenderedArtifact('mg');
await verifyCancelledRenderedArtifact('xml');
await verifyCancelledSubtitleArtifact();
await verifyRunnerChecksAbortBeforeCompletion();
await verifyCommittedTargetWinsLateAbort();
await verifyNormalArtifactExport();
await verifyTerminalProgressClearsTransientDetail();
await verifyUnexpectedFailureClearsTransientDetail();
await verifyTerminalProgressPreservesMeaningfulDetail();
await verifyAgentExportTracking();

async function verifyServerRenderIdTracking() {
  const store = createExportJobStore();
  const firstId = store.start({
    label: 'render-x.mp4',
    targetPath: '/tmp/render-x.mp4',
    execute: async ({ setters }) => {
      setters.setServerRenderId?.('render-x');
      throw new Error('destination failure');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().jobs.find((job) => job.id === firstId)?.serverRenderId, 'render-x');

  store.recover({
    id: 'server-export-render-r',
    label: 'render-r.mp4',
    targetPath: '/tmp/render-r.mp4',
    createdAt: Date.now(),
    execute: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    store.getSnapshot().jobs.find((job) => job.id === 'server-export-render-r')?.serverRenderId,
    'render-r',
  );

  const secondId = store.start({
    label: 'render-x.mp4',
    targetPath: '/tmp/render-x-2.mp4',
    execute: async ({ setters }) => {
      setters.setServerRenderId?.('render-x');
      setters.setServerRenderId?.(null);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().jobs.find((job) => job.id === firstId)?.serverRenderId, null);
  assert.equal(store.getSnapshot().jobs.find((job) => job.id === secondId)?.serverRenderId, null);
}

await verifyServerRenderIdTracking();

assert.equal(formatExportDuration(65_000), '01:05');
assert.equal(formatExportDuration(3_723_000), '1:02:03');
assert.equal(
  exportEtaMs({ phase: 'rendering', percent: 10, startedAt: 0, processedFrames: 797, totalFrames: 79737 }, 1_000),
  null,
  'ETA waits for at least 2s of elapsed samples before estimating',
);
assert.ok(
  Math.abs(
    (exportEtaMs({ phase: 'rendering', percent: 10, startedAt: 0, processedFrames: 797, totalFrames: 79737 }, 10_000) ?? 0)
      - 990_426.6,
  ) < 500,
  'ETA estimates remaining time from actual frame ratio rather than inflated 10% floor',
);
assert.ok(
  Math.abs(exportProgressFillRatio({ phase: 'rendering', percent: 10, startedAt: 0, processedFrames: 5581, totalFrames: 79737 }) - 5581 / 79737) < 0.0001,
  'fill bar tracks exact rendered frame progress smoothly',
);
assert.equal(
  formatProgressPercent({ phase: 'rendering', percent: 7, startedAt: 0, processedFrames: 5581, totalFrames: 79737 }),
  '7.0%',
);

console.log('background export store verification passed');
