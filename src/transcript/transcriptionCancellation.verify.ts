import assert from 'node:assert/strict';
import { cancellableTranscription, isTranscriptionCancelled } from './transcriptionCancellation';
import { checkLocalModelReadiness } from './localModelReadiness';
import { tryDesktopNativeAsr } from './desktop-native-asr';
import { __resetLocalAsrClient, localTranscribePath, warmUpLocalAsr } from './local-asr';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';

const originals = new Map(['fetch', 'navigator', 'window', 'localStorage', 'Worker', 'AudioContext'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, value });
const config = { device: 'wasm' as const, modelTier: 'base' as const, modelId: 'onnx-community/whisper-base_timestamped', revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e' };
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
  assert.fail('bounded asynchronous check timed out');
};

try {
  const token = new AbortController();
  let finish!: (value: string) => void;
  let cancelled = 0;
  const late = cancellableTranscription(() => new Promise<string>((resolve) => { finish = resolve; }), token.signal, () => cancelled++);
  await Promise.resolve(); token.abort();
  await assert.rejects(late, isTranscriptionCancelled);
  finish('late');
  assert.equal(cancelled, 1);
  assert.throws(() => cancellableTranscription(async () => 'never', token.signal), isTranscriptionCancelled);
  const cleanupToken = new AbortController();
  const cleanupFailure = cancellableTranscription(() => new Promise(() => {}), cleanupToken.signal, () => { throw new Error('backend cleanup failed'); });
  cleanupToken.abort();
  await assert.rejects(cleanupFailure, isTranscriptionCancelled, 'throwing cleanup must still settle cancellation');

  setGlobal('navigator', { userAgent: 'Windows', deviceMemory: 8 });
  setGlobal('localStorage', { getItem: () => null });
  let downloaded = true;
  let brokenCatalog = false;
  const fetched: string[] = [];
  setGlobal('fetch', async (path: string, options?: RequestInit) => {
    fetched.push(path);
    if (path === '/api/asr-models') return brokenCatalog ? new Response('{}', { status: 503 }) : Response.json({ models: [{ modelId: config.modelId, downloaded }] });
    if (options?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '100' } });
    return new Response(new Uint8Array([0]));
  });
  assert.equal((await checkLocalModelReadiness()).state, 'ready');
  downloaded = false;
  assert.equal((await checkLocalModelReadiness()).state, 'missing');
  brokenCatalog = true;
  assert.equal((await checkLocalModelReadiness()).state, 'unavailable');
  brokenCatalog = false; downloaded = true;
  assert.deepEqual(fetched, ['/api/asr-models', '/api/asr-models', '/api/asr-models'], 'preflight must not read source audio or start inference');
  const usualFetch = globalThis.fetch;
  setGlobal('fetch', () => new Promise(() => {}));
  assert.equal((await checkLocalModelReadiness(undefined, 10)).state, 'unavailable', 'hung model catalog must have a bounded preflight');
  const checkingToken = new AbortController();
  const checking = checkLocalModelReadiness(checkingToken.signal, 100);
  checkingToken.abort();
  await assert.rejects(checking, isTranscriptionCancelled);
  setGlobal('fetch', usualFetch);

  let nativeRequest = '';
  const nativeCancels: string[] = [];
  let nativeFallbacks = 0;
  let unsubscribes = 0;
  setGlobal('window', { openChatCutDesktop: { inference: {
    getCapabilities: async () => ({ asr: { available: true, contractId: ASR_INFERENCE_CONTRACT.id } }),
    subscribeProgress: () => () => unsubscribes++,
    transcribe: (request: { requestId: string }) => { nativeRequest = request.requestId; return new Promise(() => {}); },
    cancel: async (id: string) => { nativeCancels.push(id); },
  } } });
  const nativeToken = new AbortController();
  const native = tryDesktopNativeAsr({ sourcePath: '/media/uploads/voice.wav', config, language: 'zh', signal: nativeToken.signal, onFallback: () => nativeFallbacks++ });
  await waitFor(() => Boolean(nativeRequest));
  nativeToken.abort();
  await assert.rejects(native, isTranscriptionCancelled);
  assert.deepEqual(nativeCancels, [nativeRequest]);
  assert.equal(nativeFallbacks, 0, 'cancellation must not restart browser inference');
  assert.equal(unsubscribes, 1);

  Reflect.deleteProperty(globalThis, 'window');
  class WorkerMock {
    static all: WorkerMock[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    terminated = false;
    transcribing = false;
    constructor() { WorkerMock.all.push(this); }
    postMessage(request: { id: number; type: string }) {
      if (request.type === 'load') queueMicrotask(() => this.onmessage?.({ data: { id: request.id, type: 'result', result: { text: '', chunks: [] } } }));
      else this.transcribing = true;
    }
    terminate() { this.terminated = true; }
  }
  setGlobal('Worker', WorkerMock);
  setGlobal('AudioContext', class {
    async decodeAudioData() { return { numberOfChannels: 1, length: 1600, sampleRate: 16000, getChannelData: () => new Float32Array(1600).fill(0.25) }; }
    async close() {}
  });
  await warmUpLocalAsr([config.modelId]);
  assert.equal(WorkerMock.all.length, 1);
  const browserToken = new AbortController();
  const browser = localTranscribePath('/media/uploads/voice.wav', undefined, { signal: browserToken.signal });
  await waitFor(() => WorkerMock.all[1]?.transcribing === true);
  browserToken.abort();
  await assert.rejects(browser, isTranscriptionCancelled);
  assert.equal(WorkerMock.all[1].terminated, true);
  assert.equal(WorkerMock.all[0].terminated, false, 'cancelled caption job must leave unrelated shared ingestion model alone');
  console.log('transcriptionCancellation.verify: late/pre-cancel, fail-closed model preflight, native cancel/no fallback and private worker cancellation passed');
} finally {
  __resetLocalAsrClient();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
