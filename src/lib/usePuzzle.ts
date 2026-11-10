import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { playSound } from '../sound';
import type { Classification } from '../coach';

export interface PuzzleData {
  id: string;
  rating: number;
  themes: string[];
  solution: string[];
  fen: string;
  lastMove: [string, string] | null;
  color: 'w' | 'b';
  gameUrl?: string;
  day?: string;
}

export type PuzzleStatus = 'play' | 'correct' | 'wrong' | 'solved' | 'shown';

export interface PuzzleOutcome {
  solved: boolean;
  assisted: boolean;
  seconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

/**
 * Logik einer Taktikaufgabe. `onOutcome` wird genau einmal aufgerufen:
 * beim ersten Fehler, beim Lösen oder wenn die Lösung angezeigt wird.
 */
export function usePuzzle(p: PuzzleData | null, onOutcome: (o: PuzzleOutcome) => void, opts: { fast?: boolean } = {}) {
  const replyDelay = opts.fast ? 160 : 450;
  const wrongDelay = opts.fast ? 350 : 700;
  const chess = useRef(new Chess());
  const step = useRef(0);
  const reported = useRef(false);
  const assisted = useRef(false);
  const started = useRef(Date.now());
  const token = useRef(0);
  const outcomeRef = useRef(onOutcome);
  outcomeRef.current = onOutcome;

  const [fen, setFen] = useState(p?.fen ?? new Chess().fen());
  const [lastMove, setLastMove] = useState<[string, string] | undefined>();
  const [status, setStatus] = useState<PuzzleStatus>('play');
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [badge, setBadge] = useState<{ square: string; c: Classification }>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const report = useCallback((solved: boolean) => {
    if (reported.current) return;
    reported.current = true;
    outcomeRef.current({ solved, assisted: assisted.current, seconds: Math.round((Date.now() - started.current) / 1000) });
  }, []);

  const sync = useCallback((lm?: [string, string]) => {
    setFen(chess.current.fen());
    setLastMove(lm);
  }, []);

  useEffect(() => {
    if (!p) return;
    token.current++;
    chess.current = new Chess(p.fen);
    step.current = 0;
    reported.current = false;
    assisted.current = false;
    started.current = Date.now();
    setStatus('play');
    setShapes([]);
    setBadge(undefined);
    setBusy(false);
    setFailed(false);
    sync(p.lastMove ?? undefined);
    return () => { token.current++; };
  }, [p, sync]);

  const play = (uci: string) => {
    const m = chess.current.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    playSound(m.captured ? 'capture' : m.san.includes('+') ? 'check' : 'move');
    sync([m.from, m.to]);
    return m;
  };

  /** Gegner antwortet; true wenn die Aufgabe damit fertig ist */
  const advance = useCallback(async () => {
    if (!p) return;
    const t = token.current;
    if (step.current >= p.solution.length) {
      setStatus('solved');
      playSound('end');
      report(true);
      return;
    }
    setBusy(true);
    await sleep(replyDelay);
    if (t !== token.current) return;
    play(p.solution[step.current]);
    step.current++;
    setBusy(false);
    setStatus('correct');
  }, [p, report]);

  const onMove = useCallback(
    async (from: string, to: string, promotion?: string) => {
      if (!p || busy || status === 'solved' || status === 'shown') return;
      const c = chess.current;
      const piece = c.get(from as any);
      const expected = p.solution[step.current];
      // Umwandlung: die Figur der Lösung nehmen (auch Unterverwandlung), sonst Dame
      const promo = piece?.type === 'p' && (to[1] === '8' || to[1] === '1') ? (promotion ?? ((expected.startsWith(from + to) && expected[4]) || 'q')) : undefined;
      let m;
      try {
        m = c.move({ from, to, promotion: promo });
      } catch {
        sync(lastMove);
        return;
      }
      const ok = uciOf(m) === expected || c.isCheckmate();
      playSound(m.captured ? 'capture' : m.san.includes('+') ? 'check' : 'move');
      sync([m.from, m.to]);
      setShapes([]);
      if (ok) {
        step.current++;
        setBadge({ square: m.to, c: 'best' });
        setStatus('correct');
        if (c.isCheckmate()) step.current = p.solution.length;
        await advance();
      } else {
        setBadge({ square: m.to, c: 'mistake' });
        setStatus('wrong');
        setFailed(true);
        report(false);
        const t = token.current;
        setBusy(true);
        await sleep(wrongDelay);
        if (t !== token.current) return;
        c.undo();
        sync(lastMove);
        setBadge(undefined);
        setBusy(false);
      }
    },
    [p, busy, status, advance, report, sync, lastMove],
  );

  /** Erster Klick: Figur markieren, zweiter Klick: Zug als Pfeil */
  const hint = useCallback(() => {
    if (!p || status === 'solved' || status === 'shown') return;
    assisted.current = true;
    const u = p.solution[step.current];
    const already = shapes.length > 0 && !shapes[0].dest;
    setShapes(already ? [{ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush: 'green' }] : [{ orig: u.slice(0, 2) as Key, brush: 'green' }]);
  }, [p, status, shapes]);

  const showSolution = useCallback(async () => {
    if (!p || status === 'solved' || status === 'shown') return;
    const t = ++token.current;
    // Playback owns the board from here; discard any unaccepted move still awaiting rollback.
    const accepted = new Chess(p.fen);
    for (const uci of p.solution.slice(0, step.current)) {
      accepted.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    }
    chess.current = accepted;
    const previous = accepted.history({ verbose: true }).at(-1);
    sync(previous ? [previous.from, previous.to] : p.lastMove ?? undefined);
    assisted.current = true;
    report(false);
    setStatus('shown');
    setShapes([]);
    setBadge(undefined);
    setBusy(true);
    while (step.current < p.solution.length) {
      await sleep(550);
      if (t !== token.current) return;
      const m = play(p.solution[step.current]);
      if (step.current % 2 === 0) setBadge({ square: m.to, c: 'best' });
      step.current++;
    }
    setBusy(false);
  }, [p, report, status, sync]);

  const turnColor = fen.split(' ')[1] as 'w' | 'b';
  const canMove = !!p && !busy && status !== 'solved' && status !== 'shown' && turnColor === p.color;

  return {
    fen,
    lastMove,
    status,
    shapes,
    badge,
    failed,
    canMove,
    moveNumber: Math.floor(step.current / 2) + 1,
    totalMoves: p ? Math.ceil(p.solution.length / 2) : 0,
    onMove,
    hint,
    showSolution,
    /** Lösung als SAN-Liste (für den Coach) */
    solutionSan: () => {
      if (!p) return [];
      const c = new Chess(p.fen);
      return p.solution.map((u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    },
  };
}
