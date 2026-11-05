import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewMove } from '../src/coach.ts';
import type { EngineLine } from '../src/engine.ts';

const line = (pv: string[], score: number, mate: number | null = null): EngineLine => ({ multipv: 1, depth: 20, score, mate, pv });

// Weiß: Kf7, Dg5 – Schwarz: Kh8. Dg7# setzt matt, Dg6 ist Patt.
const FEN = '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1';
const before = [line(['g5g7'], 99999, 1), line(['g5e7', 'h8h7', 'e7g7'], 99998, 2)];

test('Patt aus Gewinnstellung ist ein Patzer, kein exzellenter Zug', () => {
  // Nach Patt liefert die Engine keine Zeilen
  const r = reviewMove(FEN, 'g5g6', 'Qg6', before, [], 40);
  assert.equal(r.classification, 'blunder');
  assert.ok(r.winLoss > 45, `winLoss ${r.winLoss}`);
});

test('Matt bleibt der beste Zug ohne Verlust', () => {
  const r = reviewMove(FEN, 'g5g7', 'Qg7#', before, [], 40);
  assert.equal(r.classification, 'best');
  assert.equal(r.winLoss, 0);
});

test('normaler Zug wird über die Bewertung danach eingestuft', () => {
  // Schwarz am Zug sieht nach Qe7 Matt in 1 gegen sich (mate -1)
  const r = reviewMove(FEN, 'g5e7', 'Qe7', before, [line(['h8g8'], -99999, -1)], 40);
  assert.equal(r.classification, 'excellent');
});
