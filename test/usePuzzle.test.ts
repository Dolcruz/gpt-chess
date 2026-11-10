import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { Chess } from 'chess.js';
import { usePuzzle, type PuzzleData, type PuzzleOutcome } from '../src/lib/usePuzzle.ts';

const puzzle: PuzzleData = {
  id: 'opening', rating: 1200, themes: [], color: 'w', lastMove: null,
  fen: new Chess().fen(), solution: ['e2e4', 'e7e5', 'g1f3'],
};

function position(moves: string[]) {
  const chess = new Chess(puzzle.fen);
  for (const move of moves) chess.move(move);
  return chess.fen();
}

function mount(t: TestContext, fast = false) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let current!: ReturnType<typeof usePuzzle>;
  const outcomes: PuzzleOutcome[] = [];
  const onOutcome = (outcome: PuzzleOutcome) => outcomes.push(outcome);
  function Probe({ data }: { data: PuzzleData | null }) {
    current = usePuzzle(data, onOutcome, { fast });
    return null;
  }
  let root!: ReturnType<typeof create>;
  act(() => { root = create(createElement(Probe, { data: puzzle })); });
  t.after(() => act(() => root.unmount()));
  return {
    get current() { return current; },
    outcomes,
    update(data: PuzzleData | null) { act(() => root.update(createElement(Probe, { data }))); },
    unmount() { act(() => root.unmount()); },
    async tick(ms: number) { await act(async () => { t.mock.timers.tick(ms); }); },
    move(from: string, to: string) {
      let pending!: Promise<void>;
      act(() => { pending = current.onMove(from, to); });
      return pending;
    },
    show() {
      let pending!: Promise<void>;
      act(() => { pending = current.showSolution(); });
      // Observe failures immediately, including failures reached while advancing fake time.
      return pending.then(() => null, (error: unknown) => error);
    },
  };
}

for (const fast of [false, true]) {
  test(`solution replaces a pending wrong move (${fast ? 'fast' : 'normal'})`, async (t) => {
    const h = mount(t, fast);
    const move = h.move('d2', 'd4');
    assert.equal(h.current.status, 'wrong');
    const shown = h.show();
    assert.equal(h.current.fen, puzzle.fen);
    assert.equal(h.current.status, 'shown');
    for (let i = 0; i < puzzle.solution.length; i++) await h.tick(550);
    assert.equal(await shown, null);
    await move;
    assert.equal(h.current.fen, position(puzzle.solution));
    assert.equal(h.current.status, 'shown');
    assert.equal(h.current.canMove, false);
    assert.deepEqual(h.outcomes, [{ solved: false, assisted: false, seconds: 0 }]);
  });

  test(`solution owns a pending opponent reply (${fast ? 'fast' : 'normal'})`, async (t) => {
    const h = mount(t, fast);
    const move = h.move('e2', 'e4');
    const shown = h.show();
    const delay = fast ? 160 : 450;
    await h.tick(delay);
    await move;
    assert.equal(h.current.status, 'shown');
    assert.equal(h.current.canMove, false);
    assert.equal(h.current.fen, position(['e2e4']));
    await h.tick(550 - delay);
    assert.equal(h.current.fen, position(['e2e4', 'e7e5']));
    await h.tick(550);
    assert.equal(await shown, null);
    assert.equal(h.current.fen, position(puzzle.solution));
    assert.equal(h.current.status, 'shown');
    assert.deepEqual(h.outcomes, [{ solved: false, assisted: true, seconds: 0 }]);
  });
}

test('solution keeps accepted progress and removes only the tentative mistake', async (t) => {
  const h = mount(t);
  const correct = h.move('e2', 'e4');
  await h.tick(450);
  await correct;
  const wrong = h.move('f1', 'c4');
  const shown = h.show();
  assert.equal(h.current.fen, position(['e2e4', 'e7e5']));
  assert.deepEqual(h.current.lastMove, ['e7', 'e5']);
  await h.tick(550);
  assert.equal(await shown, null);
  assert.equal(h.current.fen, position(puzzle.solution));
  await h.tick(150);
  await wrong;
  assert.equal(h.current.fen, position(puzzle.solution));
  assert.equal(h.current.badge?.square, 'f3');
  assert.equal(h.current.status, 'shown');
  assert.equal(h.outcomes.length, 1);
});

test('solution also works after the wrong move has already been undone', async (t) => {
  const h = mount(t);
  const move = h.move('d2', 'd4');
  await h.tick(700);
  await move;
  assert.equal(h.current.fen, puzzle.fen);
  const shown = h.show();
  for (let i = 0; i < puzzle.solution.length; i++) await h.tick(550);
  assert.equal(await shown, null);
  assert.equal(h.current.fen, position(puzzle.solution));
});

test('repeated solution clicks cannot start concurrent playback', async (t) => {
  const h = mount(t);
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = h.current.showSolution();
    second = h.current.showSolution();
  });
  const results = [first, second].map((p) => p.then(() => null, (error: unknown) => error));
  await h.tick(550);
  assert.equal(h.current.fen, position(['e2e4']));
  await h.tick(550);
  await h.tick(550);
  assert.deepEqual(await Promise.all(results), [null, null]);
  assert.equal(h.current.fen, position(puzzle.solution));
  assert.equal(h.outcomes.length, 1);
});

test('loading another puzzle cancels the previous solution playback', async (t) => {
  const h = mount(t);
  const shown = h.show();
  const next = { ...puzzle, id: 'next', solution: ['d2d4', 'd7d5', 'c1f4'] };
  h.update(next);
  await h.tick(550);
  assert.equal(await shown, null);
  assert.equal(h.current.fen, next.fen);
  assert.equal(h.current.status, 'play');
  assert.equal(h.current.canMove, true);
  assert.equal(h.outcomes.length, 1);
});

test('clearing the puzzle cancels its pending reply', async (t) => {
  const h = mount(t);
  const move = h.move('e2', 'e4');
  h.update(null);
  const fen = h.current.fen;
  await h.tick(450);
  await move;
  assert.equal(h.current.fen, fen);
  assert.equal(h.current.canMove, false);
  assert.equal(h.outcomes.length, 0);
});

test('unmount stops solution playback at the next animation boundary', async (t) => {
  const h = mount(t);
  let completed = false;
  const shown = h.show().then((error) => { completed = true; return error; });
  h.unmount();
  await h.tick(550);
  assert.equal(completed, true);
  assert.equal(await shown, null);
  assert.equal(h.outcomes.length, 1);
});
