import assert from 'node:assert/strict';

const requests: unknown[] = [];
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body ?? '{}')));
  return new Response(null, { status: 204 });
}) as typeof fetch;

const { startUiLocaleSync } = await import('./localeSync');
startUiLocaleSync('ru');
assert.deepEqual(requests, [{ UI_LOCALE: 'zh' }], 'legacy server locale is migrated to Chinese');

console.log('localeSync.verify: server UI locale is pinned to Chinese');