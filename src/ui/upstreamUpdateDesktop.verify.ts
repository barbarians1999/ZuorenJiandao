import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopUpdateState } from '../../shared/desktop-update';

let onState: ((state: DesktopUpdateState) => void) | null = null;
const failedCheck: DesktopUpdateState = {
  phase: 'error',
  source: 'auto',
  currentVersion: '0.1.8',
  failedOperation: 'check',
};
const unsupportedCheck: DesktopUpdateState = {
  phase: 'unsupported',
  source: 'manual',
  currentVersion: '0.1.9',
};
let checkState = failedCheck;
let fetchCalls = 0;
const updates = {
  getState: async () => {
    await delay(0);
    return { phase: 'idle', source: 'auto', currentVersion: '0.1.8' } as const;
  },
  check: async () => {
    onState?.(checkState);
    return checkState;
  },
  download: async () => failedCheck,
  install: async () => failedCheck,
  subscribe: (listener: (state: DesktopUpdateState) => void) => {
    onState = listener;
    return () => { onState = null; };
  },
};

Object.defineProperties(globalThis, {
  fetch: {
    configurable: true,
    value: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 });
    },
  },
  window: {
    configurable: true,
    value: { openChatCutDesktop: { updates } },
  },
});

// Runtime import is intentional: the desktop bridge must exist before this stateful module is evaluated.
const moduleUrl = new URL('./upstreamUpdate.ts', import.meta.url);
const updateModule = await import(moduleUrl.href);
updateModule.startAutomaticUpstreamUpdateCheck();
await Promise.resolve();
assert.equal(updateModule.getUpstreamUpdateState().phase, 'idle');

await delay(5);
assert.equal(
  updateModule.getUpstreamUpdateState().phase,
  'idle',
  'disabled automatic checks must stay idle',
);

checkState = unsupportedCheck;
await updateModule.requestUpstreamUpdateCheck('manual');
assert.equal(updateModule.getUpstreamUpdateState().phase, 'idle');
assert.equal(fetchCalls, 0, 'internal builds must not query the upstream GitHub API');

console.log('upstreamUpdateDesktop.verify: disabled automatic and manual upstream checks stay offline');
