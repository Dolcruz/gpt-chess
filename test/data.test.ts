import { test } from 'node:test';
import assert from 'node:assert/strict';

// Zeitzone westlich von UTC: dort liest new Date('2026-11-05') den Vortag (UTC-Mitternacht)
process.env.TZ = 'America/New_York';
const { dayKey, streak } = await import('../src/lib/data.ts');

test('dayKey lässt ein reines Datum unverändert', () => {
  assert.equal(dayKey('2026-11-05'), '2026-11-05');
});

test('dayKey eines Zeitstempels nutzt die lokale Zeitzone', () => {
  // 03:00 UTC am 6.11. ist in New York noch der 5.11.
  assert.equal(dayKey('2026-11-06T03:00:00.000Z'), '2026-11-05');
});

test('Serie beim Tagesrätsel zählt den gestrigen Tag', () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  assert.equal(streak([dayKey(y)]), 1);
  const t = new Date();
  assert.equal(streak([dayKey(y), dayKey(t)]), 2);
});
