import assert from 'node:assert/strict';
import { DerivativeQueue } from './derivative-queue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// 1. A running filmstrip must leave room for a proxy while other low jobs wait.
{
  const queue = new DerivativeQueue(2);
  const started: string[] = [];
  const low1 = deferred<string>();
  const low2 = deferred<string>();
  const high1 = deferred<string>();
  const proxy = deferred<string>();

  const l1 = queue.acquire('low-1', async () => { started.push('low-1'); return low1.promise; }, { priority: 'low' });
  const l2 = queue.acquire('low-2', async () => { started.push('low-2'); return low2.promise; }, { priority: 'low' });
  await Promise.resolve();
  assert.deepEqual(started, ['low-1'], 'second low job waits so it cannot block a new proxy');

  const p = queue.acquire('proxy', async () => { started.push('proxy'); return proxy.promise; });
  await Promise.resolve();
  assert.deepEqual(started, ['low-1', 'proxy'], 'proxy starts without waiting for a filmstrip to finish');

  const h1 = queue.acquire('high-1', async () => { started.push('high-1'); return high1.promise; }, { priority: 'high' });
  await Promise.resolve();
  assert.deepEqual(started, ['low-1', 'proxy'], 'a late high job waits when both slots are busy');
  low1.resolve('done-l1');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['low-1', 'proxy', 'high-1'], 'high priority takes the first available slot');

  high1.resolve('done-h1');
  low2.resolve('done-l2');
  proxy.resolve('done-proxy');
  assert.deepEqual(await Promise.all([l1.promise, p.promise, h1.promise, l2.promise]), ['done-l1', 'done-proxy', 'done-h1', 'done-l2']);
}

// 2. Priority ordering + priority promotion on deduped key + FIFO within same tier.
{
  const queue = new DerivativeQueue(1);
  const order: string[] = [];
  const gate = deferred<void>();

  const blocker = queue.acquire('blocker', async () => { order.push('blocker'); await gate.promise; }, { priority: 'high' });
  const lowA = queue.acquire('low-a', async () => { order.push('low-a'); }, { priority: 'low' });
  const normalA = queue.acquire('normal-a', async () => { order.push('normal-a'); }, { priority: 'normal' });
  const normalB = queue.acquire('normal-b', async () => { order.push('normal-b'); }, { priority: 'normal' });
  // Promote low-a to high while queued
  const promoted = queue.acquire('low-a', async () => { throw new Error('must dedupe'); }, { priority: 'high' });

  gate.resolve();
  await Promise.all([blocker.promise, lowA.promise, normalA.promise, normalB.promise, promoted.promise]);
  assert.deepEqual(order, ['blocker', 'low-a', 'normal-a', 'normal-b']);
}

// 3. Cancellation of a queued job cleans up cleanly.
{
  const queue = new DerivativeQueue(1);
  const gate = deferred<void>();
  const blocker = queue.acquire('blocker', () => gate.promise, { priority: 'high' });
  const queued = queue.acquire('cancel-me', async () => 'never', { priority: 'low' });
  queued.release();
  await assert.rejects(queued.promise, { name: 'AbortError' });
  gate.resolve();
  await blocker.promise;
}

console.log('derivative-queue.verify: passed');
