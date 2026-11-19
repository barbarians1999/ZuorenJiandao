import assert from 'node:assert/strict';
import { createServer } from 'vite';
import type { TranscriptResult } from './types';
import type { LocalModelReadiness } from './localModelReadiness';
import { isTranscriptionCancelled } from './transcriptionCancellation';

// Exercise the actual hook's async control flow with deterministic hooks and
// deferred backends. No browser, ASR model, media extraction or filesystem output.
const slots: unknown[] = [];
let cursor = 0;
let cleanup: (() => void) | undefined;
const calls: Array<{ path: string; resolve: (value: TranscriptResult) => void; note: (text: string) => void; signal: AbortSignal }> = [];
let readiness: LocalModelReadiness = { state: 'ready', label: 'Base' };
let deferredChecks = false;
const checks: Array<(value: LocalModelReadiness) => void> = [];
const harness = {
  useState(initial: unknown) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useCallback: <T>(fn: T) => fn,
  useEffect(fn: () => () => void) { if (!cleanup) cleanup = fn(); },
  transcribe(path: string, note: (value: string) => void, opts: { signal: AbortSignal }) {
    return new Promise<TranscriptResult>((resolve) => calls.push({ path, note, resolve, signal: opts.signal }));
  },
  check() { return deferredChecks ? new Promise<LocalModelReadiness>((resolve) => checks.push(resolve)) : Promise.resolve(readiness); },
};
const globalKey = '__ccPracticalTranscriptHook';
Object.defineProperty(globalThis, globalKey, { configurable: true, value: harness });
const virtual = (name: string) => `\0caption-practical-${name}`;
const server = await createServer({ configFile: false, appType: 'custom', ssr: { noExternal: true }, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null }, plugins: [{
  name: 'practical-transcript-backend-test', enforce: 'pre',
  resolveId(id, importer) {
    if (!importer?.replaceAll('\\', '/').endsWith('/src/transcript/useTranscript.ts')) return null;
    if (id === 'react') return virtual('react');
    if (id === './provider') return virtual('provider');
    if (id === './localModelReadiness') return virtual('readiness');
    if (id === '../i18n/locale') return virtual('locale');
    return null;
  },
  load(id) {
    const h = `globalThis.${globalKey}`;
    if (id === virtual('react')) return `export const useState=${h}.useState; export const useRef=${h}.useRef; export const useEffect=${h}.useEffect; export const useCallback=${h}.useCallback;`;
    if (id === virtual('provider')) return `export class TranscriptionError extends Error {} export const transcribePath=${h}.transcribe;`;
    if (id === virtual('readiness')) return `export const checkLocalModelReadiness=${h}.check; export const localModelReadinessMessage=(r)=>r.state;`;
    if (id === virtual('locale')) return 'export const t=(text,values={})=>text.replace(/\\{([^}]+)\\}/g,(_,key)=>String(values[key]??(\"{\"+key+\"}\")));';
    return null;
  },
}] });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const result: TranscriptResult = { text: '你好', words: [{ text: '你好', start: 0, end: 1000 }], utterances: [] };
try {
  const { useTranscript } = await server.ssrLoadModule('/src/transcript/useTranscript.ts');
  const render = () => { cursor = 0; return useTranscript(); };
  let hook = render();
  readiness = { state: 'missing', label: 'Base' };
  await assert.rejects(hook.runMany([{ path: '/voice.wav', itemId: 'a', label: 'A' }], () => assert.fail('not ready result must not apply')), /missing/);
  assert.equal(calls.length, 0, 'not ready model blocks audio preparation');
  assert.equal(render().status, 'error');

  readiness = { state: 'ready', label: 'Base' };
  const applied: string[] = [];
  hook = render();
  const cancelled = hook.runMany([{ path: '/a.wav', itemId: 'a', label: 'A' }, { path: '/b.wav', itemId: 'b', label: 'B' }], (id: string) => applied.push(id));
  await tick();
  assert.equal(calls.length, 1);
  render().cancel();
  calls[0].note('late progress');
  calls[0].resolve(result);
  await assert.rejects(cancelled, isTranscriptionCancelled);
  assert.deepEqual([...applied], []);
  assert.equal(calls.length, 1, 'cancel stops the next clip');
  assert.equal(render().status, 'idle');
  assert.match(render().progressNote, /已取消/);

  const normal = render().runMany([{ path: '/c.wav', itemId: 'c', label: 'C' }], (id: string) => applied.push(id));
  await tick(); calls[1].note('识别当前素材 57%');
  assert.match(render().progressNote, /识别当前素材 57%/, 'actual per-file inference progress reaches the UI status');
  calls[1].resolve(result); await normal;
  assert.deepEqual([...applied], ['c']); assert.equal(render().status, 'done');
  assert.equal(calls[1].signal.aborted, true, 'successful attempt releases its private model resources');

  deferredChecks = true;
  const old = render().checkModel(); const fresh = render().checkModel();
  checks[1]({ state: 'ready', label: 'New model' }); await fresh;
  checks[0]({ state: 'missing', label: 'Old model' }); await old;
  assert.deepEqual(render().modelReadiness, { state: 'ready', label: 'New model' }, 'late old readiness must not overwrite latest settings check');
  deferredChecks = false;

  const obsolete = render().runMany([{ path: '/old.wav', itemId: 'old', label: 'Old' }], (id: string) => applied.push(id));
  await tick();
  const replacement = render().runMany([{ path: '/new.wav', itemId: 'new', label: 'New' }], (id: string) => applied.push(id));
  await tick(); calls[2].resolve(result); await assert.rejects(obsolete, isTranscriptionCancelled);
  assert.equal(render().status, 'uploading', 'old cleanup cannot reset an active replacement');
  calls[3].resolve(result); await replacement;
  assert.deepEqual([...applied], ['c', 'new']);

  const unmounted = render().runMany([{ path: '/unmount.wav', itemId: 'unmount', label: 'Unmount' }], (id: string) => applied.push(id));
  await tick(); cleanup?.(); calls[4].resolve(result);
  await assert.rejects(unmounted, isTranscriptionCancelled);
  assert.deepEqual([...applied], ['c', 'new']);
  console.log('useTranscriptPractical.verify: preflight blocks, cancel/no next/late progress, retry, latest model check, replacement and unmount guards passed');
} finally {
  await server.close();
  Reflect.deleteProperty(globalThis, globalKey);
}
