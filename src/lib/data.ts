import { lang } from '../i18n';
// Persistente Daten (liegen auf dem lokalen Server in data/store.json) + abgeleitete Statistiken.
import type { Classification } from '../coach';

export interface GameRecord {
  id: string;
  date: string; // ISO
  mode: 'coach' | 'bot' | 'practice';
  botId: string;
  botName: string;
  botRating: number;
  color: 'w' | 'b';
  result: 'win' | 'loss' | 'draw';
  reason: string;
  startFen?: string;
  sans: string[];
  takebacks: number;
  hints: number;
  /** Genauigkeit laut Live-Coach (nur Coach-Modus) */
  accuracy?: number | null;
  /** Vollständige Analyse (aus der Partie-Analyse, für beide Seiten) */
  analysis?: GameAnalysis;
  /** Zeitkontrolle in Sekunden (nur Partien mit Uhr, z. B. Bullet) */
  timeControl?: { base: number; inc: number };
  /** Bedenkzeit je Halbzug in Millisekunden */
  times?: number[];
  /** Restzeit des Ziehenden nach jedem Halbzug in Millisekunden */
  clocks?: number[];
}

export interface RushRecord {
  id: string;
  date: string;
  /** Dauer in Sekunden */
  mode: number;
  score: number;
  errors: number;
  maxRating: number;
  failed: { id: string; fen: string; rating: number }[];
}

/** Bullet = Partien mit Uhr und höchstens 3 Minuten Grundzeit */
export const isBullet = (g: GameRecord) => !!g.timeControl && g.timeControl.base <= 180;
export const tcLabel = (tc: { base: number; inc: number }) => (tc.base < 60 ? `${tc.base} s` : `${tc.base / 60}`) + (tc.inc ? `+${tc.inc}` : tc.base < 60 ? '' : '+0');

export interface PlyAnalysis {
  /** Bewertung nach dem Zug, Sicht Weiß, in Centipawns (Matt ≈ ±10000) */
  cp: number;
  mate: number | null;
  best: string; // bester Zug (UCI) in der Stellung VOR diesem Zug
  bestSan: string;
  c: Classification;
  winLoss: number;
}

export interface GameAnalysis {
  depth: number;
  startCp: number;
  plies: PlyAnalysis[];
  accuracy: { w: number; b: number };
}

export interface PuzzleAttempt {
  id: string;
  date: string;
  rating: number;
  themes: string[];
  solved: boolean;
  /** mit Hinweis oder Lösung angezeigt → zählt nicht als gelöst */
  assisted: boolean;
  daily?: string;
  seconds: number;
}

export interface LessonProgress {
  id: string;
  solved: number;
  attempts: number;
  completed: boolean;
  date: string;
}

export interface OpeningProgress {
  id: string;
  runs: number;
  perfect: number;
  date: string;
}

type Collections = { games: GameRecord; puzzles: PuzzleAttempt; lessons: LessonProgress; openings: OpeningProgress; rush: RushRecord };

export const store = {
  async list<K extends keyof Collections>(col: K): Promise<Collections[K][]> {
    const r = await fetch(`/api/store/${col}`);
    if (!r.ok) throw new Error('Daten konnten nicht geladen werden');
    return r.json();
  },
  async put<K extends keyof Collections>(col: K, item: Collections[K]): Promise<Collections[K]> {
    const r = await fetch(`/api/store/${col}/${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (!r.ok) throw new Error('Speichern fehlgeschlagen');
    return r.json();
  },
  async remove(col: keyof Collections, id: string) {
    await fetch(`/api/store/${col}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Ratings ----------

const expected = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));

export interface RatingPoint {
  date: string;
  rating: number;
}

/** Spielstärke gegen die Bots: Elo-Verlauf über alle gewerteten Partien (Start 800) */
export function botRatingHistory(games: GameRecord[]): RatingPoint[] {
  let r = 800;
  const out: RatingPoint[] = [];
  const rated = games.filter((g) => g.mode !== 'practice').sort((a, b) => a.date.localeCompare(b.date));
  rated.forEach((g, i) => {
    const k = i < 15 ? 48 : i < 40 ? 32 : 20;
    const s = g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0;
    r = r + k * (s - expected(r, g.botRating));
    out.push({ date: g.date, rating: Math.round(r) });
  });
  return out;
}

/** Puzzle-Rating (Start 1200), nur der erste Versuch je Aufgabe zählt */
export function puzzleRatingHistory(attempts: PuzzleAttempt[]): RatingPoint[] {
  let r = 1200;
  const out: RatingPoint[] = [];
  const sorted = [...attempts].sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach((p, i) => {
    const k = i < 20 ? 40 : 20;
    const s = p.solved && !p.assisted ? 1 : 0;
    r = r + k * (s - expected(r, p.rating));
    out.push({ date: p.date, rating: Math.round(r) });
  });
  return out;
}

export const currentRating = (h: RatingPoint[], fallback: number) => (h.length ? h[h.length - 1].rating : fallback);

/** Lichess-Schwierigkeit relativ zum eigenen Puzzle-Rating (anonym gilt dort 1500) */
export function difficultyFor(rating: number) {
  return rating < 1050 ? 'easiest' : rating < 1350 ? 'easier' : rating < 1650 ? 'normal' : rating < 1950 ? 'harder' : 'hardest';
}

/** Genauigkeit wie bei chess.com aus dem durchschnittlichen Verlust an Gewinnchance */
export function accuracyFromLoss(avgLoss: number) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * avgLoss) - 3.1669));
}

export function dayKey(d: Date | string = new Date()) {
  // Reines Datum („2026-11-05“, z. B. beim Tagesrätsel) ist schon ein Tag – new Date() läse es als UTC-Mitternacht
  // und verschöbe es westlich von UTC auf den Vortag
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Wie viele Tage in Folge (bis heute/gestern) es Aktivität gab */
export function streak(dates: string[]) {
  const days = new Set(dates.map((d) => dayKey(d)));
  let n = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

// Gespeicherte Spielende-Gründe in beiden Sprachen (alte Partien haben deutsche Texte)
const REASONS: [string, string][] = [
  ['durch Schachmatt', 'by checkmate'],
  ['durch Patt', 'by stalemate'],
  ['durch dreifache Wiederholung', 'by threefold repetition'],
  ['durch ungenügendes Material', 'by insufficient material'],
  ['durch 50-Züge-Regel', 'by the 50-move rule'],
  ['durch Aufgabe', 'by resignation'],
  ['durch Zeitüberschreitung', 'on time'],
  ['Zeit abgelaufen, aber zu wenig Material zum Mattsetzen', 'Time ran out, but not enough material to mate'],
];

export function reasonLabel(r: string) {
  for (const [de, en] of REASONS) if (r === de || r === en) return lang === 'en' ? en : de;
  return r;
}

/** Partie auf Zeit verloren (unabhängig von der Sprache, in der sie gespeichert wurde) */
export const isTimeLoss = (g: GameRecord) => g.result === 'loss' && (g.reason === 'durch Zeitüberschreitung' || g.reason === 'on time');
