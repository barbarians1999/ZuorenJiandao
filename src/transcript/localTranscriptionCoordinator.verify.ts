import assert from 'node:assert/strict';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import { __resetTranscribeJobs, enqueueTranscription, getTranscribeJob,
  untranscribedTimelineItemIdsForRevision } from './transcribe-jobs';
import { loadTranscriptionCheckpoint, resetTranscriptionCheckpointQueues, saveTranscriptionCheckpoint } from '../persist/transcriptionJobStore';
import { resetSharedKvMemory } from '../persist/sharedKv';
import { transcribePathResumable } from './provider';

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
let calls = 0;
let delayed: (() => Promise<unknown>) | undefined;
const result = (text: string) => ({ backend: 'cpu', text, chunks: [{ text, start: 0, end: 300 }] });
const inference = {
  getCapabilities: async () => ({ asr: { available: true, contractId: ASR_INFERENCE_CONTRACT.id } }),
  subscribeProgress: () => () => {},
  transcribe: async () => { calls++; return delayed ? delayed() : result(`local-${calls}`); },
};
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail('local coordinator did not reach the expected terminal state');
}
const asset = (id: string, sourceRevision = 'rev-current') => ({ id, sourceRevision,
  src: `/media/uploads/${id}.mp4`, kind: 'video' as const });
const asrPath = '/media/uploads/native-asr.wav';

try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { openChatCutDesktop: { inference } } });
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/asr-models', 'local coordinator never calls a cloud or media upload endpoint');
    return new Response(null, { status: 404 });
  };
  resetSharedKvMemory(); resetTranscriptionCheckpointQueues(); __resetTranscribeJobs();
  let delivered = 0;
  enqueueTranscription('local-a', asset('stale', 'old'), { asrPath,
    getCurrentAsset: () => asset('stale', 'new'), onComplete: () => delivered++ });
  await waitUntil(() => getTranscribeJob('local-a', 'stale')?.status !== 'running');
  assert.equal(getTranscribeJob('local-a', 'stale')?.stale, true);
  assert.equal(getTranscribeJob('local-a', 'stale')?.words, undefined);
  assert.equal(delivered, 0, 'relinked-source results cannot commit');

  enqueueTranscription('local-a', asset('live'), { asrPath, onComplete: () => delivered++ });
  enqueueTranscription('local-a', asset('live'), { asrPath, onComplete: () => assert.fail('duplicate publication') });
  await waitUntil(() => getTranscribeJob('local-a', 'live')?.status === 'done');
  assert.equal(delivered, 1);
  const first = getTranscribeJob('local-a', 'live')?.words?.[0]?.text;
  enqueueTranscription('local-b', asset('live'), { asrPath });
  await waitUntil(() => getTranscribeJob('local-b', 'live')?.status === 'done');
  assert.notEqual(getTranscribeJob('local-b', 'live')?.words?.[0]?.text, first);
  assert.equal(getTranscribeJob('local-a', 'live')?.words?.[0]?.text, first, 'projects remain isolated');
  const checkpoint = await loadTranscriptionCheckpoint({ projectId: 'local-a', assetId: 'live', sourceRevision: 'rev-current' });
  assert.equal(checkpoint?.provider, 'local');
  assert.equal(checkpoint?.uploadUrl, undefined);

  const key = { projectId: 'local-restart', assetId: 'resume', sourceRevision: 'rev-current' };
  await saveTranscriptionCheckpoint({ ...key, languageCode: 'zh', provider: 'assemblyai', providerJobId: 'retired-cloud-id',
    providerStatus: 'processing', uploadUrl: 'https://retired.example/upload', retry: { attempts: 1, lastAttemptAt: Date.now() },
    createdAt: Date.now(), updatedAt: Date.now() });
  enqueueTranscription(key.projectId, asset(key.assetId), { asrPath });
  await waitUntil(() => getTranscribeJob(key.projectId, key.assetId)?.status === 'done');
  const resumed = await loadTranscriptionCheckpoint(key);
  assert.equal(resumed?.provider, 'local');
  assert.equal(resumed?.uploadUrl, undefined);
  assert.notEqual(resumed?.providerJobId, 'retired-cloud-id');

  let resolveOld!: (value: unknown) => void;
  const pending = new Promise((done) => { resolveOld = done; });
  delayed = () => pending;
  const beforeCalls = calls;
  const published: string[] = [];
  enqueueTranscription('generation', asset('same', 'old'), { asrPath,
    onComplete: (job) => published.push(job.sourceRevision) });
  await waitUntil(() => calls > beforeCalls);
  delayed = undefined;
  enqueueTranscription('generation', asset('same', 'new'), { asrPath,
    onComplete: (job) => published.push(job.sourceRevision) });
  await waitUntil(() => getTranscribeJob('generation', 'same')?.status === 'done');
  resolveOld(result('old terminal'));
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(published, ['new']);
  assert.equal(getTranscribeJob('generation', 'same')?.sourceRevision, 'new');
  const oldCheckpoint = await loadTranscriptionCheckpoint({ projectId: 'generation', assetId: 'same', sourceRevision: 'old' });
  assert.notEqual(oldCheckpoint?.providerStatus, 'completed');

  await assert.rejects(transcribePathResumable('/media/uploads/master.mp4', {}, () => {}, undefined, {}, 'assemblyai'),
    /Cloud transcription was removed/);
  const sameNameItems = [
    { id: 'a', sourceRevision: 'a', name: 'same.mp4' },
    { id: 'b', sourceRevision: 'b', name: 'same.mp4' },
    { id: 'stale', sourceRevision: 'a', transcriptStale: true, transcript: [{ text: 'old', start: 0, end: 100 }] },
    { id: 'fresh', sourceRevision: 'a', transcript: [{ text: 'fresh', start: 0, end: 100 }] },
  ];
  const targets = untranscribedTimelineItemIdsForRevision(sameNameItems, 'a');
  assert.deepEqual(targets, ['a', 'stale'], 'same names do not cross source-revision identity');
} finally {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else delete (globalThis as { window?: unknown }).window;
  __resetTranscribeJobs(); resetSharedKvMemory(); resetTranscriptionCheckpointQueues();
}
console.log('localTranscriptionCoordinator.verify: stale, generations, dedup, project isolation and retired checkpoints passed');
