import assert from 'node:assert/strict';
import {
  transcribePathResumable,
  type AssemblyAiProviderStatus,
  type AssemblyAiResumeCheckpoint,
} from './assemblyai';
import {
  loadTranscriptionCheckpoint,
  resetTranscriptionCheckpointQueues,
  saveTranscriptionCheckpoint,
  type TranscriptionCheckpoint,
  type TranscriptionProviderStatus,
} from '../persist/transcriptionJobStore';
import { resetSharedKvMemory } from '../persist/sharedKv';
import {
  __resetTranscribeJobs,
} from './transcribe-jobs';

const originalFetch = globalThis.fetch;
const projectId = 'project-asr-verify';
const providerStatus = (status: AssemblyAiProviderStatus | undefined): TranscriptionProviderStatus => {
  if (status === 'uploaded') return 'uploaded';
  if (status === 'submitted') return 'submitted';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'failed';
  return 'processing';
};

try {
  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  const key = { projectId, assetId: 'asset-resume', sourceRevision: 'rev-resume' };
  let uploadCount = 0;
  let createCount = 0;
  let pollCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      uploadCount += 1;
      assert.equal(JSON.parse(String(init?.body)).src, '/media/uploads/asr.wav');
      return Response.json({ uploadUrl: 'https://assembly.example/upload/once', bytes: 5 });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') {
      createCount += 1;
      return Response.json({ id: 'provider-job-1' });
    }
    if (url.endsWith('/transcript/provider-job-1')) {
      pollCount += 1;
      if (pollCount === 1) throw new TypeError('refresh interrupted polling');
      return Response.json({
        status: 'completed',
        text: '恢复成功',
        words: [{ text: '恢复成功', start: 0, end: 500 }],
        utterances: [],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const createdAt = Date.now();
  const writer = async (provider: AssemblyAiResumeCheckpoint) => {
    const previous = await loadTranscriptionCheckpoint(key);
    const checkpoint: TranscriptionCheckpoint = {
      projectId: key.projectId,
      assetId: key.assetId,
      sourceRevision: key.sourceRevision,
      provider: 'assemblyai',
      providerJobId: provider.providerJobId,
      providerStatus: providerStatus(provider.providerStatus),
      uploadUrl: provider.uploadUrl,
      languageCode: 'zh',
      retry: previous?.retry ?? { attempts: 1, lastAttemptAt: createdAt },
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: Date.now(),
    };
    await saveTranscriptionCheckpoint(checkpoint);
  };

  await assert.rejects(() => transcribePathResumable(
    '/media/uploads/master.mp4',
    {},
    writer,
    undefined,
    { asrPath: '/media/uploads/asr.wav', languageCode: 'zh' },
  ));
  const afterRefresh = await loadTranscriptionCheckpoint(key);
  assert.equal(afterRefresh?.providerJobId, 'provider-job-1', 'provider id is durable before the first poll');
  assert.equal(afterRefresh?.uploadUrl, 'https://assembly.example/upload/once');

  const resumed = await transcribePathResumable(
    '/media/uploads/master.mp4',
    {
      uploadUrl: afterRefresh?.uploadUrl,
      providerJobId: afterRefresh?.providerJobId,
      providerStatus: 'submitted',
    },
    writer,
    undefined,
    { languageCode: 'zh' },
  );
  assert.equal(resumed.words[0]?.text, '恢复成功');
  assert.equal(uploadCount, 1, 'refresh resume never uploads the same source twice');
  assert.equal(createCount, 1, 'refresh resume never creates a second provider job');

  // Coordinator now runs exclusively on the local engine. Its stale-result,
  // deduplication and restart checks live in localTranscriptionCoordinator.verify.
  await import('./localTranscriptionCoordinator.verify');
} finally {
  globalThis.fetch = originalFetch;
  __resetTranscribeJobs();
  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
}

console.log('assemblyai-resume.verify: ok');
