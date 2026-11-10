import { L } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Flame, Microscope, RotateCcw, Timer, Trophy, X, Zap } from 'lucide-react';
import { Board } from '../components/Board';
import { Avatar, Piece } from '../components/ui';
import { store, uid, type RushRecord } from '../lib/data';
import { usePuzzle, type PuzzleData, type PuzzleOutcome } from '../lib/usePuzzle';
import { navigate } from '../router';
import { playSound } from '../sound';
import { RushQueue } from '../lib/rushQueue';

const MAX_ERRORS = 3;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Schwierigkeit steigt mit jeder gelösten Aufgabe – wie bei Puzzle Rush */
function tierFor(solved: number) {
  return solved < 6 ? 'easiest' : solved < 12 ? 'easier' : solved < 18 ? 'normal' : solved < 25 ? 'harder' : 'hardest';
}

async function fetchBatch(difficulty: string, signal: AbortSignal): Promise<PuzzleData[]> {
  const r = await fetch(`/api/puzzle/pool?difficulty=${difficulty}&n=3`, { signal });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? L('Aufgaben konnten nicht geladen werden', 'Could not load puzzles'));
  return j;
}

export function Rush({ seconds }: { seconds: number }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'running' | 'done'>('loading');
  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [results, setResults] = useState<{ p: PuzzleData; ok: boolean }[]>([]);
  const [left, setLeft] = useState(seconds * 1000);
  const [history, setHistory] = useState<RushRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const queue = useRef(new RushQueue(fetchBatch));
  const session = useRef(0);
  const endAt = useRef(0);
  const savedRef = useRef(false);

  const score = results.filter((r) => r.ok).length;
  const errors = results.length - score;
  const best = useMemo(() => Math.max(0, ...history.filter((h) => h.mode === seconds).map((h) => h.score)), [history, seconds]);

  useEffect(() => {
    store.list('rush').then(setHistory).catch(() => {});
  }, []);

  /** Erste Aufgaben vorladen; nach einem Netzwerkfehler erneut aufrufbar. */
  const prepare = useCallback(async () => {
    const id = session.current;
    setLoading(true);
    setError('');
    try {
      await queue.current.refill(tierFor(0));
      if (id !== session.current) return;
      if (!queue.current.size) throw new Error(L('Keine Aufgaben erhalten', 'No puzzles received'));
      setPhase('ready');
    } catch (e: any) {
      if (id === session.current) setError(e.message);
    } finally {
      if (id === session.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    prepare();
    return () => {
      session.current++;
      queue.current.reset();
    };
  }, [prepare]);

  const next = useCallback(
    async (solved: number) => {
      const id = session.current;
      setPuzzle(null);
      setLoading(true);
      setError('');
      try {
        const p = await queue.current.take(tierFor(solved));
        if (id !== session.current) return;
        if (!p) throw new Error(L('Keine Aufgaben erhalten', 'No puzzles received'));
        setPuzzle(p);
        // Ein Vorladefehler wird beim nächsten benötigten Puzzle erneut versucht.
        queue.current.refill(tierFor(solved)).catch(() => {});
      } catch (e: any) {
        if (id === session.current) setError(e.message);
      } finally {
        if (id === session.current) setLoading(false);
      }
    },
    [],
  );

  function start() {
    session.current++;
    setResults([]);
    savedRef.current = false;
    endAt.current = performance.now() + seconds * 1000;
    setLeft(seconds * 1000);
    setPhase('running');
    next(0);
  }

  const finish = useCallback(() => {
    session.current++;
    queue.current.reset();
    setPhase('done');
  }, []);

  // Countdown
  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => {
      const l = endAt.current - performance.now();
      setLeft(Math.max(0, l));
      if (l <= 0) finish();
    }, 100);
    return () => window.clearInterval(id);
  }, [phase, finish]);

  const onOutcome = useCallback(
    (o: PuzzleOutcome) => {
      if (!puzzle || phase !== 'running') return;
      if (performance.now() >= endAt.current) {
        finish();
        return;
      }
      const ok = o.solved && !o.assisted;
      const nextRs = [...results, { p: puzzle, ok }];
      const solved = nextRs.filter((r) => r.ok).length;
      const id = session.current;
      setResults(nextRs);
      setTimeout(() => {
        if (id !== session.current) return;
        if (nextRs.length - solved >= MAX_ERRORS) finish();
        else next(solved);
      }, ok ? 120 : 450);
      if (!ok) playSound('check');
    },
    [puzzle, phase, results, next, finish],
  );

  const pz = usePuzzle(puzzle, onOutcome, { fast: true });

  // Ergebnis speichern
  useEffect(() => {
    if (phase !== 'done' || savedRef.current || !results.length) return;
    savedRef.current = true;
    playSound('end');
    const rec: RushRecord = {
      id: uid(),
      date: new Date().toISOString(),
      mode: seconds,
      score,
      errors,
      maxRating: Math.max(0, ...results.filter((r) => r.ok).map((r) => r.p.rating)),
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.p.id, fen: r.p.fen, rating: r.p.rating })),
    };
    setHistory((h) => [...h, rec]);
    store.put('rush', rec).catch(() => {});
  }, [phase, results, score, errors, seconds]);

  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  const newBest = phase === 'done' && score > 0 && score >= best && history.filter((h) => h.mode === seconds).length > 0 && score === Math.max(...history.filter((h) => h.mode === seconds).map((h) => h.score));

  return (
    <div className="layout">
      <div className="board-col">
        <div className="player-bar">
          <span className="bar-icon">
            <Zap size={22} />
          </span>
          <div className="player-info">
            <div className="player-name">
              <b>Puzzle Rush · {seconds / 60} {seconds === 60 ? L('Minute', 'minute') : L('Minuten', 'minutes')}</b>
              {puzzle && phase === 'running' && <span className="rating">({puzzle.rating})</span>}
            </div>
            <div className="bar-sub">
              <span className="muted-text">{phase === 'running' && puzzle ? L(`${puzzle.color === 'w' ? 'Weiß' : 'Schwarz'} am Zug`, `${puzzle.color === 'w' ? 'White' : 'Black'} to move`) : L('So viele Aufgaben wie möglich – 3 Fehler und vorbei', 'As many puzzles as possible – 3 mistakes and you are out')}</span>
            </div>
          </div>
        </div>
        <div className="board-wrap">
          <Board
            fen={puzzle ? pz.fen : START_FEN}
            orientation={puzzle?.color === 'b' ? 'black' : 'white'}
            movable={phase === 'running' && pz.canMove ? (puzzle!.color === 'w' ? 'white' : 'black') : null}
            lastMove={phase === 'running' ? pz.lastMove : undefined}
            shapes={[]}
            badge={phase === 'running' ? pz.badge : undefined}
            onMove={(f, t) => pz.onMove(f, t)}
          />
          {phase !== 'running' && (
            <div className="over">
              <div className="over-card rush-card">
                {phase === 'done' ? (
                  <>
                    <div className="over-head">
                      <Trophy size={26} />
                      <h2>{score} {L('gelöst', 'solved')}</h2>
                      <p>{newBest ? L('Neuer Rekord!', 'New personal best!') : best ? L(`Dein Rekord: ${best}`, `Your best: ${best}`) : L('Erster Lauf', 'First run')}</p>
                    </div>
                    <div className="rush-summary">
                      <div>
                        <span>{L('Fehler', 'Mistakes')}</span>
                        <b>{errors}</b>
                      </div>
                      <div>
                        <span>{L('Schwerste gelöst', 'Hardest solved')}</span>
                        <b>{Math.max(0, ...results.filter((r) => r.ok).map((r) => r.p.rating)) || '–'}</b>
                      </div>
                    </div>
                    <div className="over-btns">
                      <button className="btn primary block" onClick={start}>
                        <RotateCcw size={16} /> {L('Nochmal', 'Again')}
                      </button>
                      <button className="btn block" onClick={() => navigate('bullet')}>
                        <ArrowLeft size={16} /> {L('Zum Bullet-Training', 'Back to bullet training')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="over-head">
                      <Zap size={26} />
                      <h2>Puzzle Rush</h2>
                      <p>
                        {seconds / 60} {seconds === 60 ? L('Minute', 'minute') : L('Minuten', 'minutes')} · {L('3 Fehler und vorbei · Aufgaben werden immer schwerer', '3 mistakes and out · puzzles keep getting harder')}
                      </p>
                    </div>
                    {error && <p className="err-text" style={{ padding: '0 18px' }}>{error}</p>}
                    <div className="over-btns">
                      <button className="btn primary block xl" onClick={error ? prepare : start} disabled={loading || (phase !== 'ready' && !error)}>
                        {error ? L('Erneut versuchen', 'Try again') : phase === 'ready' ? L('Los!', 'Go!') : L('Lade Aufgaben …', 'Loading puzzles …')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="player-bar">
          <Avatar id="you" size={40} />
          <div className="player-info">
            <div className="player-name">
              <b>{L('Du', 'You')}</b>
              <span className="rating">{L('Rekord', 'Best')} {best}</span>
            </div>
          </div>
        </div>
      </div>

      <section className="panel">
        <header className="panel-head">
          <button className="head-back" onClick={() => navigate('bullet')} title={L('Zurück', 'Back')}>
            <ArrowLeft size={18} />
          </button>
          <Zap size={21} />
          <h1>Puzzle Rush</h1>
        </header>
        <div className="panel-top">
          {phase === 'running' && !puzzle && (
            <div className="status-box" role="status">
              {error ? (
                <div>
                  <p className="err-text">{error}</p>
                  <button className="btn small" onClick={() => next(score)} disabled={loading}>{L('Erneut versuchen', 'Try again')}</button>
                </div>
              ) : <span>{L('Lade Aufgaben …', 'Loading puzzles …')}</span>}
            </div>
          )}
          <div className={`rush-timer ${left < 10_000 && phase === 'running' ? 'low' : ''}`}>
            <Timer size={26} />
            {mm}:{String(ss).padStart(2, '0')}
          </div>
          <div className="rush-stats">
            <div className="rush-score">
              <span>{L('Gelöst', 'Solved')}</span>
              <b>{score}</b>
            </div>
            <div className="rush-errors">
              <span>{L('Fehler', 'Mistakes')}</span>
              <div>
                {Array.from({ length: MAX_ERRORS }, (_, i) => (
                  <i key={i} className={i < errors ? 'hit' : ''}>
                    <X size={16} strokeWidth={3.5} />
                  </i>
                ))}
              </div>
            </div>
          </div>
          {phase === 'running' && puzzle && (
            <div className="status-box">
              <span className="status-icon piece">
                <Piece type="k" color={puzzle.color} size={30} />
              </span>
              <div>
                <b>{L(`${puzzle.color === 'w' ? 'Weiß' : 'Schwarz'} am Zug`, `${puzzle.color === 'w' ? 'White' : 'Black'} to move`)}</b>
                <span>{L('Finde den besten Zug – schnell!', 'Find the best move – fast!')}</span>
              </div>
            </div>
          )}
        </div>
        <div className="panel-body tight">
          <div className="rush-list">
            {[...results].reverse().map((r, i) => (
              <div key={results.length - i} className={`rush-item ${r.ok ? 'ok' : 'fail'}`}>
                <span className="ri-icon">{r.ok ? <Check size={14} strokeWidth={3.5} /> : <X size={14} strokeWidth={3.5} />}</span>
                <span>{L('Aufgabe', 'Puzzle')} {results.length - i}</span>
                <span className="ri-rating">{r.p.rating}</span>
                {phase === 'done' && (
                  <button className="icon-btn" title={L('Analysieren', 'Analyze')} onClick={() => navigate(`analysis/fen:${encodeURIComponent(r.p.fen)}`)}>
                    <Microscope size={15} />
                  </button>
                )}
              </div>
            ))}
            {!results.length && (
              <p className="hint-text">
                <Flame size={14} style={{ verticalAlign: -2, color: 'var(--green)' }} /> {L('Tipp: Im Rush zählt Mustererkennung. Schau zuerst auf Schachs, Schlagzüge und Drohungen.', 'Tip: in a rush, pattern recognition counts. Look at checks, captures and threats first.')}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
