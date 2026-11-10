import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RushQueue } from '../src/lib/rushQueue.ts';
import type { PuzzleData } from '../src/lib/usePuzzle.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const puzzle = (id: string): PuzzleData => ({
  id, rating: 800, themes: [], solution: ['e2e4'],
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  lastMove: null, color: 'w',
});

test('an empty board awaits the in-flight refill, however late it arrives', async () => {
  const response = deferred<PuzzleData[]>();
  let requests = 0;
  const queue = new RushQueue(async () => { requests++; return response.promise; });
  const prefetch = queue.refill('easiest');
  let delivered = false;
  const next = queue.take('easiest').then((p) => { delivered = true; return p; });
  await Promise.resolve();
  assert.equal(delivered, false);
  assert.equal(requests, 1);
  response.resolve([puzzle('late')]);
  assert.equal((await next)?.id, 'late');
  await prefetch;
});

test('queued puzzles remain available while another refill is pending', async () => {
  const response = deferred<PuzzleData[]>();
  let requests = 0;
  const queue = new RushQueue(async () => ++requests === 1 ? [puzzle('first'), puzzle('second')] : response.promise);
  await queue.refill('easiest');
  const refill = queue.refill('easiest');
  assert.equal((await queue.take('easiest'))?.id, 'first');
  assert.equal((await queue.take('easiest'))?.id, 'second');
  response.resolve([puzzle('third')]);
  await refill;
  assert.equal((await queue.take('easiest'))?.id, 'third');
});

test('a failed request is reported and a later attempt can recover', async () => {
  let requests = 0;
  const queue = new RushQueue(async () => {
    if (++requests === 1) throw new Error('offline');
    return [puzzle('recovered')];
  });
  await assert.rejects(queue.take('easiest'), /offline/);
  assert.equal((await queue.take('easiest'))?.id, 'recovered');
  assert.equal(requests, 2);
});

test('reset aborts old work and a late response cannot populate or consume the new run', async () => {
  const oldResponse = deferred<PuzzleData[]>();
  const freshResponse = deferred<PuzzleData[]>();
  const signals: AbortSignal[] = [];
  const queue = new RushQueue((_difficulty, signal) => {
    signals.push(signal);
    return signals.length === 1 ? oldResponse.promise : freshResponse.promise;
  });
  const oldTake = queue.take('hardest');
  queue.reset();
  assert.equal(signals[0].aborted, true);
  const freshPrefetch = queue.refill('easiest');
  freshResponse.resolve([puzzle('new')]);
  await freshPrefetch;
  // A loader that ignores abort must still be unable to affect the next run.
  oldResponse.resolve([puzzle('old')]);
  assert.equal(await oldTake, null);
  assert.equal(queue.size, 1);
  assert.equal((await queue.take('easiest'))?.id, 'new');
});

test('finishing an old request does not clear a new in-flight request', async () => {
  const oldResponse = deferred<PuzzleData[]>();
  const freshResponse = deferred<PuzzleData[]>();
  let requests = 0;
  const queue = new RushQueue(() => ++requests === 1 ? oldResponse.promise : freshResponse.promise);
  const oldTake = queue.take('hardest');
  queue.reset();
  const freshPrefetch = queue.refill('easiest');
  oldResponse.resolve([puzzle('old')]);
  await oldTake;
  const freshTake = queue.take('easiest');
  assert.equal(requests, 2);
  freshResponse.resolve([puzzle('new')]);
  await freshPrefetch;
  assert.equal((await freshTake)?.id, 'new');
});

test('an empty response returns no puzzle without scheduling retries', async () => {
  let requests = 0;
  const queue = new RushQueue(async () => { requests++; return []; });
  assert.equal(await queue.take('easiest'), null);
  assert.equal(requests, 1);
});

test('prefetch keeps the existing threshold and removes duplicate IDs within a batch', async () => {
  let requests = 0;
  const queue = new RushQueue(async () => {
    requests++;
    return [puzzle('one'), puzzle('one'), puzzle('two'), puzzle('three')];
  });
  await queue.refill('easiest');
  assert.equal(queue.size, 3);
  await queue.refill('easiest');
  assert.equal(requests, 1);
});
