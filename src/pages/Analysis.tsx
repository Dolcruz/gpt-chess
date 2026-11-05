import { L } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Move } from 'chess.js';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import { ArrowUpDown, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Cpu, FileInput, GraduationCap, ListOrdered, Microscope, RotateCcw, Undo2 } from 'lucide-react';
import { Board } from '../components/Board';
import { CoachChat } from '../components/CoachChat';
import { EvalGraph } from '../components/EvalGraph';
import { Avatar, ClassIcon } from '../components/ui';
import { Engine, formatScore, LiveAnalyzer, winPercent, type EngineLine } from '../engine';
import { CLASS_INFO, positionBlock, pvToSan, type Classification } from '../coach';
import { store, type GameAnalysis, type GameRecord } from '../lib/data';
import { analyzeGame, CLASS_ORDER, whiteCp } from '../lib/review';
import { TimeBars } from '../components/TimeBars';
import { reasonLabel, tcLabel } from '../lib/data';
import { playSound } from '../sound';
import { navigate } from '../router';
import type { PageProps } from '../App';
import { useVariationView, variationShapes } from '../lib/variation';
import { VariationBar } from '../components/Variation';


const START = new Chess().fen();
const LIVE_DEPTH = 24;
const REVIEW_DEPTH = 16;

interface CachedEval {
  cp: number;
  mate: number | null;
  best: string;
  depth: number;
}

/** Einstufung eines Zuges anhand der Bewertungen davor/danach (Sicht des ziehenden Spielers) */
function classify(before: CachedEval, after: CachedEval, mover: 'w' | 'b', uci: string): { c: Classification; loss: number } {
  const s = mover === 'w' ? 1 : -1;
  const loss = Math.max(0, winPercent(before.cp * s) - winPercent(after.cp * s));
  if (uci === before.best) return { c: 'best', loss };
  return { c: loss < 2 ? 'excellent' : loss < 5 ? 'good' : loss < 10 ? 'inaccuracy' : loss < 20 ? 'mistake' : 'blunder', loss };
}

export function Analysis({ gameId, loggedIn, settings }: PageProps & { gameId?: string }) {
  const [game, setGame] = useState<GameRecord | null>(null);
  const [startFen, setStartFen] = useState(START);
  const [mainline, setMainline] = useState<string[]>([]);
  const [line, setLine] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [live, setLive] = useState<{ fen: string; lines: EngineLine[] } | null>(null);
  const [engineOn, setEngineOn] = useState(true);
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [tab, setTab] = useState<'moves' | 'coach'>('moves');
  const [loadText, setLoadText] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [arrows, setArrows] = useState<string[]>([]);
  const [, bump] = useState(0);
  const vv = useVariationView();

  const engines = useRef<{ live: Engine; review: Engine; analyzer: LiveAnalyzer } | null>(null);
  const evals = useRef(new Map<string, CachedEval>());
  const cancelled = useRef(false);

  // Engines anlegen/aufräumen
  useEffect(() => {
    const live = new Engine();
    engines.current = { live, review: new Engine(), analyzer: new LiveAnalyzer(live) };
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      engines.current?.analyzer.cancel();
      engines.current?.live.destroy();
      engines.current?.review.destroy();
    };
  }, []);

  // Partie bzw. Stellung laden
  useEffect(() => {
    if (!gameId) return;
    if (gameId.startsWith('fen:')) {
      const f = decodeURIComponent(gameId.slice(4));
      try {
        const c = new Chess(f);
        setStartFen(c.fen());
        setOrientation(c.turn() === 'w' ? 'white' : 'black');
      } catch {}
      return;
    }
    store.list('games').then((gs) => {
      const g = gs.find((x) => x.id === gameId);
      if (!g) return;
      setGame(g);
      setStartFen(g.startFen ?? START);
      setMainline(g.sans);
      setLine(g.sans);
      setCursor(0);
      setOrientation(g.color === 'w' ? 'white' : 'black');
      if (g.analysis) setAnalysis(g.analysis);
    });
  }, [gameId]);

  const runReview = useCallback(async () => {
    if (!game || !engines.current) return;
    setProgress(0);
    const a = await analyzeGame(engines.current.review, game.startFen, game.sans, REVIEW_DEPTH, (d, t) => setProgress(d / t), () => cancelled.current);
    setProgress(null);
    if (!a) return;
    setAnalysis(a);
    const updated = { ...game, analysis: a };
    setGame(updated);
    store.put('games', updated).catch(() => {});
  }, [game]);

  // Partie automatisch analysieren, wenn noch nicht geschehen
  useEffect(() => {
    if (game && !game.analysis && progress === null && !analysis) runReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  // Stellung an der aktuellen Position
  const { fen, history } = useMemo(() => {
    const c = new Chess(startFen);
    const h: Move[] = [];
    for (const san of line.slice(0, cursor)) h.push(c.move(san));
    return { fen: c.fen(), history: h };
  }, [startFen, line, cursor]);

  const last = history[history.length - 1];
  const prevFen = last ? last.before : null;
  const onMainline = cursor <= mainline.length && line.slice(0, cursor).every((m, i) => m === mainline[i]);
  const deviated = mainline.length > 0 && !line.every((m, i) => m === mainline[i]);

  // Live-Analyse der aktuellen Stellung
  useEffect(() => {
    const e = engines.current;
    if (!e) return;
    if (!engineOn) {
      e.analyzer.cancel();
      return;
    }
    const c = new Chess(fen);
    if (c.isGameOver()) {
      e.analyzer.cancel();
      setLive({ fen, lines: [] });
      // Matt/Patt: Die Engine liefert nichts, die Bewertung steht aber fest (sonst bleibt der letzte Zug ewig „wird bewertet“)
      evals.current.set(fen, c.isCheckmate() ? { cp: c.turn() === 'w' ? -10000 : 10000, mate: 0, best: '', depth: 99 } : { cp: 0, mate: null, best: '', depth: 99 });
      bump((x) => x + 1);
      return;
    }
    e.analyzer.analyze(fen, {
      depth: LIVE_DEPTH,
      multipv: 3,
      onUpdate: (lines) => {
        setLive({ fen, lines });
        if (lines[0] && lines[0].depth >= 10) {
          const w = whiteCp(fen, lines);
          const prev = evals.current.get(fen);
          if (!prev || prev.depth <= lines[0].depth) {
            evals.current.set(fen, { cp: w.cp, mate: w.mate, best: lines[0].pv[0], depth: lines[0].depth });
            bump((x) => x + 1);
          }
        }
      },
    });
  }, [fen, engineOn]);

  // Für die Bewertung des letzten Zuges braucht es auch die Stellung davor (z. B. nach einem Sprung)
  useEffect(() => {
    const e = engines.current;
    if (!e || !prevFen || !engineOn) return;
    const known = evals.current.get(prevFen);
    if (known && known.depth >= 16) return;
    let stale = false;
    e.review.analyze(prevFen, { depth: 18, movetime: 2500, multipv: 1 }).then((lines) => {
      if (stale || !lines[0]) return;
      const w = whiteCp(prevFen, lines);
      const cur = evals.current.get(prevFen);
      if (!cur || cur.depth < lines[0].depth) evals.current.set(prevFen, { cp: w.cp, mate: w.mate, best: lines[0].pv[0], depth: lines[0].depth });
      bump((x) => x + 1);
    });
    return () => {
      stale = true;
    };
  }, [prevFen, engineOn]);

  // Tastatur: ← → zum Navigieren
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (vv.active && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        vv.go(vv.idx + (e.key === 'ArrowLeft' ? -1 : 1));
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'ArrowRight') setCursor((c) => Math.min(line.length, c + 1));
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(line.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [line.length, vv]);

  useEffect(() => {
    setArrows([]);
    vv.close();
  }, [fen, vv.close]);

  function onMove(from: string, to: string) {
    const c = new Chess(fen);
    let m;
    try {
      m = c.move({ from, to, promotion: 'q' });
    } catch {
      return;
    }
    playSound(m.captured ? 'capture' : m.san.includes('+') ? 'check' : 'move');
    // Gleicher Zug wie in der Linie → einfach vorwärts, sonst neue Variante ab hier
    if (line[cursor] === m.san) setCursor(cursor + 1);
    else {
      setLine([...line.slice(0, cursor), m.san]);
      setCursor(cursor + 1);
    }
  }

  function load() {
    const t = loadText.trim();
    setLoadErr('');
    if (!t) return;
    try {
      if (/^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}\s[wb]/.test(t)) {
        const c = new Chess(t);
        setStartFen(c.fen());
        setMainline([]);
        setLine([]);
        setCursor(0);
      } else {
        const c = new Chess();
        c.loadPgn(t);
        const sans = c.history();
        const header = c.getHeaders?.() ?? (c as any).header?.();
        const sf = header?.FEN ?? START;
        setStartFen(sf);
        setMainline(sans);
        setLine(sans);
        setCursor(sans.length);
      }
      setLoadText('');
    } catch {
      setLoadErr(L('Das ist weder eine gültige FEN noch eine gültige PGN.', 'That is neither a valid FEN nor a valid PGN.'));
    }
  }

  // Einstufung des letzten Zuges
  let lastClass: { c: Classification; loss: number; before?: CachedEval; after?: CachedEval } | null = null;
  if (last) {
    if (analysis && onMainline && analysis.plies[cursor - 1]) {
      const p = analysis.plies[cursor - 1];
      lastClass = { c: p.c, loss: p.winLoss };
    } else if (prevFen) {
      const before = evals.current.get(prevFen);
      const after = evals.current.get(fen);
      if (before && after && before.depth >= 14 && after.depth >= 14) lastClass = { ...classify(before, after, last.color, last.from + last.to + (last.promotion ?? '')), before, after };
    }
  }

  const lines = live && live.fen === fen ? live.lines : [];
  const top = lines[0] ? whiteCp(fen, lines) : null;
  const evalPct = top ? (top.mate !== null ? (top.mate > 0 ? 100 : top.mate < 0 ? 0 : top.cp > 0 ? 100 : 0) : winPercent(top.cp)) : 50;
  const evalLabel = top ? (top.mate !== null ? `M${Math.abs(top.mate)}` : (Math.abs(top.cp) / 100).toFixed(1)) : '0.0';

  let shapes: DrawShape[] = arrows.map((a) => ({ orig: a.slice(0, 2) as Key, dest: a.slice(2, 4) as Key, brush: 'green' }));
  if (!shapes.length && engineOn && lines[0]?.pv[0]) {
    const u = lines[0].pv[0];
    shapes = [{ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush: 'blue' }];
  }

  const pairs: { n: number; w?: number; b?: number }[] = [];
  const startBlack = startFen.split(' ')[1] === 'b';
  line.forEach((_, i) => {
    const isWhite = startBlack ? i % 2 === 1 : i % 2 === 0;
    if (isWhite || !pairs.length) pairs.push({ n: pairs.length + 1, [isWhite ? 'w' : 'b']: i });
    else pairs[pairs.length - 1].b = i;
  });

  const plyClass = (i: number): Classification | null => {
    if (analysis && i < mainline.length && line.slice(0, i + 1).every((m, k) => m === mainline[k])) return analysis.plies[i]?.c ?? null;
    return null;
  };

  const context = () => {
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    const W = L('Weiß', 'White');
    const B = L('Schwarz', 'Black');
    const student = L('Schüler', 'Student');
    return positionBlock(fen, [
      game
        ? L(
            `Partie: ${game.color === 'w' ? `${student} (${W})` : `${game.botName} (${W})`} gegen ${game.color === 'w' ? game.botName : student} – Ergebnis aus Sicht des Schülers: ${game.result} (${reasonLabel(game.reason)}). Der Schüler spielte ${game.color === 'w' ? W : B}.`,
            `Game: ${game.color === 'w' ? `${student} (${W})` : `${game.botName} (${W})`} vs ${game.color === 'w' ? game.botName : student} – result from the student's view: ${game.result} (${reasonLabel(game.reason)}). The student played ${game.color === 'w' ? W : B}.`,
          )
        : L('Freie Analyse.', 'Free analysis.'),
      `${L('Züge bis hier', 'Moves so far')}: ${line.slice(0, cursor).map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}.${m}` : m)).join(' ') || L('(Ausgangsstellung)', '(starting position)')}`,
      lines.length
        ? `${L(`Stockfish (Tiefe ${lines[0].depth}, Sicht Weiß)`, `Stockfish (depth ${lines[0].depth}, White's view)`)}:\n${lines.map((l) => `${formatScore(l.score * sign, l.mate !== null ? l.mate * sign : null)}: ${pvToSan(fen, l.pv, 6).join(' ')}`).join('\n')}`
        : '',
      last && lastClass
        ? L(
            `Letzter Zug ${last.san}: ${CLASS_INFO[lastClass.c].label} (Verlust ≈ ${lastClass.loss.toFixed(1)} Prozentpunkte Gewinnchance)`,
            `Last move ${last.san}: ${CLASS_INFO[lastClass.c].label} (loss ≈ ${lastClass.loss.toFixed(1)} percentage points of winning chance)`,
          )
        : '',
      analysis && game
        ? `${L('Genauigkeit', 'Accuracy')}: ${W} ${analysis.accuracy.w}%, ${B} ${analysis.accuracy.b}%. ${L('Fehler/Patzer des Schülers', "Student's mistakes/blunders")}: ${analysis.plies
            .map((p, i) => ({ p, i }))
            .filter(({ p, i }) => (i % 2 === 0) === (game.color === 'w') && (p.c === 'mistake' || p.c === 'blunder'))
            .map(({ p, i }) => `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'}${game.sans[i]} (${CLASS_INFO[p.c].label}, ${L('besser', 'better')} ${p.bestSan})`)
            .join(', ') || L('keine', 'none')}`
        : '',
      game?.times && game.timeControl
        ? `${L(`Zeitkontrolle ${tcLabel(game.timeControl)} (Bullet). Bedenkzeit und Restzeit des Schülers je Zug`, `Time control ${tcLabel(game.timeControl)} (bullet). Student's thinking time and remaining time per move`)}: ${game.times
            .map((t, i) => ({ t, i }))
            .filter(({ i }) => (i % 2 === 0) === (game.color === 'w'))
            .map(({ t, i }) => `${Math.floor(i / 2) + 1}.${game.sans[i]} ${(t / 1000).toFixed(1)}s (${L('Rest', 'left')} ${((game.clocks?.[i] ?? 0) / 1000).toFixed(0)}s${analysis?.plies[i] && ['mistake', 'blunder'].includes(analysis.plies[i].c) ? `, ${CLASS_INFO[analysis.plies[i].c].label}` : ''})`)
            .join(', ')}`
        : '',
    ]);
  };

  const counts = (side: 'w' | 'b') => {
    const r: Partial<Record<Classification, number>> = {};
    analysis?.plies.forEach((p, i) => {
      const mover = (startBlack ? i % 2 === 1 : i % 2 === 0) ? 'w' : 'b';
      if (mover === side) r[p.c] = (r[p.c] ?? 0) + 1;
    });
    return r;
  };

  const whiteName = game ? (game.color === 'w' ? L('Du', 'You') : game.botName) : L('Weiß', 'White');
  const blackName = game ? (game.color === 'b' ? L('Du', 'You') : game.botName) : L('Schwarz', 'Black');
  const topSide = orientation === 'white' ? 'b' : 'w';
  const bar = (side: 'w' | 'b') => {
    const isYou = game && game.color === side;
    return (
      <div className="player-bar">
        <Avatar id={game ? (isYou ? 'you' : game.botId) : 'you'} size={40} />
        <div className="player-info">
          <div className="player-name">
            <b>{side === 'w' ? whiteName : blackName}</b>
            {game && !isYou && <span className="rating">({game.botRating})</span>}
          </div>
          <div className="bar-sub">{analysis && <span className="acc">{analysis.accuracy[side]} % {L('Genauigkeit', 'accuracy')}</span>}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="layout">
      <div className="board-col">
        {vv.active ? <VariationBar vv={vv} /> : bar(topSide)}
        <div className="board-row">
          <div className={`evalbar ${orientation === 'black' ? 'flip' : ''}`}>
            <div className="white" style={{ height: `${evalPct}%` }} />
            <span className={evalPct >= 50 ? 'lbl bottom' : 'lbl top'}>{evalLabel}</span>
          </div>
          <div className="board-wrap">
            <Board
              fen={vv.fen ?? fen}
              orientation={orientation}
              movable={vv.active ? null : 'both'}
              lastMove={vv.active ? vv.lastMove : last ? [last.from, last.to] : undefined}
              shapes={vv.active ? variationShapes(vv) : shapes}
              badge={!vv.active && last && lastClass ? { square: last.to, c: lastClass.c } : undefined}
              onMove={onMove}
            />
          </div>
        </div>
        {bar(topSide === 'w' ? 'b' : 'w')}
      </div>

      <section className="panel">
        <header className="panel-head">
          <Microscope size={21} />
          <h1>{game ? L('Partie-Analyse', 'Game review') : L('Analyse', 'Analysis')}</h1>
        </header>

        <div className="engine-box">
          <div className="engine-head">
            <button className={`switch-btn ${engineOn ? 'on' : ''}`} onClick={() => setEngineOn(!engineOn)} title={L('Engine an/aus', 'Engine on/off')}>
              <Cpu size={15} />
            </button>
            <span className="engine-eval">{engineOn ? (top ? (top.mate !== null ? `#${top.mate}` : `${top.cp > 0 ? '+' : ''}${(top.cp / 100).toFixed(2)}`) : '…') : L('Engine aus', 'Engine off')}</span>
            <span className="engine-depth">{engineOn && lines[0] ? `${L('Tiefe', 'Depth')} ${lines[0].depth}` : ''}</span>
          </div>
          {engineOn &&
            lines.map((l, i) => {
              const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
              const sc = l.mate !== null ? `#${l.mate * sign}` : `${l.score * sign > 0 ? '+' : ''}${((l.score * sign) / 100).toFixed(2)}`;
              return (
                <div key={i} className="engine-line">
                  <button className={`pill ${l.score * sign >= 0 ? 'w' : 'b'}`} onClick={() => onMove(l.pv[0].slice(0, 2), l.pv[0].slice(2, 4))} title={L('Ersten Zug spielen', 'Play the first move')}>
                    {sc}
                  </button>
                  <button className="pv" onClick={() => vv.open({ startFen: fen, sans: pvToSan(fen, l.pv, 12), title: `${L('Engine-Variante', 'Engine line')} ${i + 1}` }, 1)} title={L('Variante Zug für Zug ansehen', 'Step through the line move by move')}>
                    {pvToSan(fen, l.pv, 8).join(' ')}
                  </button>
                </div>
              );
            })}
          {last && (
            <div className="last-move">
              {lastClass ? <ClassIcon c={lastClass.c} size={18} /> : <span className="dot-wait" />}
              <span>
                <b>{last.san}</b> {lastClass ? <span style={{ color: CLASS_INFO[lastClass.c].color }}>{CLASS_INFO[lastClass.c].label}</span> : <span className="muted-text">{L('wird bewertet …', 'evaluating …')}</span>}
              </span>
              {lastClass?.before && lastClass.after && (
                <span className="eval-change">
                  {formatScore(lastClass.before.cp, lastClass.before.mate)} → {formatScore(lastClass.after.cp, lastClass.after.mate)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="seg-tabs flat">
          <button className={tab === 'moves' ? 'on' : ''} onClick={() => setTab('moves')}>
            <ListOrdered size={15} /> {L('Züge', 'Moves')}
          </button>
          <button className={tab === 'coach' ? 'on' : ''} onClick={() => setTab('coach')}>
            <GraduationCap size={15} /> Coach
          </button>
        </div>

        {tab === 'moves' ? (
          <div className="panel-body tight">
            {game && progress !== null && (
              <div className="review-progress">
                <span>{L('Partie wird analysiert …', 'Analyzing game …')} {Math.round(progress * 100)} %</span>
                <div className="progress">
                  <i style={{ width: `${progress * 100}%` }} />
                </div>
              </div>
            )}
            {analysis && game && (
              <>
                <EvalGraph startCp={analysis.startCp} plies={analysis.plies} cursor={onMainline ? cursor : mainline.length} onSelect={(p) => {
                  setLine(mainline);
                  setCursor(Math.max(0, Math.min(mainline.length, p)));
                }} />
                <table className="class-table">
                  <thead>
                    <tr>
                      <th>{whiteName}</th>
                      <th />
                      <th>{blackName}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="acc-row">
                      <td>{analysis.accuracy.w}</td>
                      <td>{L('Genauigkeit', 'Accuracy')}</td>
                      <td>{analysis.accuracy.b}</td>
                    </tr>
                    {CLASS_ORDER.map((c) => {
                      const w = counts('w')[c] ?? 0;
                      const b = counts('b')[c] ?? 0;
                      return (
                        <tr key={c}>
                          <td style={{ color: w ? CLASS_INFO[c].color : undefined }}>{w}</td>
                          <td>
                            <span className="ct-label">
                              <ClassIcon c={c} size={16} /> {CLASS_INFO[c].label}
                            </span>
                          </td>
                          <td style={{ color: b ? CLASS_INFO[c].color : undefined }}>{b}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
            {game?.times && (
              <TimeBars
                times={game.times}
                clocks={game.clocks}
                sans={game.sans}
                side={game.color}
                startsWhite={!startBlack}
                classes={analysis ? analysis.plies.map((p) => p.c) : undefined}
                cursor={onMainline ? cursor : -1}
                onSelect={(p) => {
                  setLine(mainline);
                  setCursor(p);
                }}
              />
            )}
            {deviated && (
              <div className="variation-banner">
                <span>{L('Du schaust dir eine eigene Variante an.', "You're looking at your own variation.")}</span>
                <button
                  className="btn small"
                  onClick={() => {
                    setLine(mainline);
                    setCursor(Math.min(cursor, mainline.length));
                  }}
                >
                  <Undo2 size={14} /> {L('Zur Partie', 'Back to game')}
                </button>
              </div>
            )}
            <div className="moves analysis-moves">
              {pairs.length === 0 && <div className="moves-empty">{L('Zieh einfach Figuren – beide Seiten sind frei beweglich.', 'Just move pieces – both sides can move freely.')}</div>}
              {pairs.map((p) => (
                <div className="move-row" key={p.n}>
                  <span className="num">{p.n}.</span>
                  {[p.w, p.b].map((i, k) =>
                    i === undefined ? (
                      <span key={k} className="mv placeholder">…</span>
                    ) : (
                      <button key={k} className={`mv ${i === cursor - 1 ? 'current' : ''} ${i >= mainline.length || line[i] !== mainline[i] ? 'var' : ''}`} onClick={() => setCursor(i + 1)}>
                        {plyClass(i) && <ClassIcon c={plyClass(i)!} size={15} />}
                        {line[i]}
                      </button>
                    ),
                  )}
                </div>
              ))}
            </div>
            {!game && (
              <div className="load-box">
                <textarea value={loadText} onChange={(e) => setLoadText(e.target.value)} placeholder={L('FEN oder PGN einfügen …', 'Paste FEN or PGN …')} rows={2} />
                {loadErr && <span className="err-text">{loadErr}</span>}
                <div className="btn-row">
                  <button className="btn small" onClick={load} disabled={!loadText.trim()}>
                    <FileInput size={14} /> {L('Laden', 'Load')}
                  </button>
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      setStartFen(START);
                      setMainline([]);
                      setLine([]);
                      setCursor(0);
                    }}
                  >
                    <RotateCcw size={14} /> {L('Grundstellung', 'Start position')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <CoachChat
            vv={vv}
            fens={() => [fen, prevFen ?? '']}
            loggedIn={loggedIn}
            settings={settings}
            context={context}
            onArrows={setArrows}
            intro={game ? L('Klick dich durch die Partie – ich erkläre dir jeden Moment. Frag z. B. „Warum war das ein Fehler?“', 'Click through the game – I\'ll explain every moment. Ask e.g. "Why was that a mistake?"') : L('Zieh beliebige Züge für beide Seiten – ich erkläre dir, was in der Stellung los ist.', 'Play any moves for both sides – I\'ll explain what\'s going on in the position.')}
            quick={[
              { label: L('Was ist der Plan?', "What's the plan?"), prompt: L('Was sind in dieser Stellung die Pläne für beide Seiten? Was würdest du als Nächstes spielen und warum?', 'What are the plans for both sides in this position? What would you play next and why?') },
              { label: L('Bewerte den letzten Zug', 'Rate the last move'), prompt: L('Bewerte den zuletzt gespielten Zug: Was war die Idee, und gab es etwas Besseres? Zeichne ggf. den besseren Zug als Pfeil.', 'Rate the last move played: what was the idea, and was there something better? Draw the better move as an arrow if needed.') },
              ...(game?.timeControl
                ? [{ label: L('Bullet-Besprechung', 'Bullet review'), prompt: L('Gib mir eine Bullet-Besprechung: Wo habe ich zu viel Zeit verbraucht, welche Fehler passierten unter Zeitdruck (wenig Restzeit), wo hätte ich schneller/einfacher spielen oder premoven können? Gib 3 konkrete Bullet-Tipps für meine nächste Partie. Max. 200 Wörter.', 'Give me a bullet review: where did I use too much time, which mistakes happened under time pressure (little time left), where could I have played faster/simpler or premoved? Give 3 concrete bullet tips for my next game. Max. 200 words.') }]
                : []),
              ...(game ? [{ label: L('Partie besprechen', 'Review game'), prompt: L('Gib mir eine Partie-Besprechung wie das Game Review auf chess.com: 1) Was lief gut, 2) die 2–3 Schlüsselmomente mit Zugnummer, 3) ein konkreter Trainingstipp. Max. 200 Wörter.', 'Give me a game review like on the big chess sites: 1) what went well, 2) the 2–3 key moments with move numbers, 3) one concrete training tip. Max. 200 words.') }] : []),
            ]}
          />
        )}

        <div className="nav-bar">
          <button className="ctrl" onClick={() => setCursor(0)} disabled={cursor === 0} title={L('Anfang', 'Start')}>
            <ChevronFirst size={20} />
          </button>
          <button className="ctrl" onClick={() => setCursor(cursor - 1)} disabled={cursor === 0} title={L('Zurück (←)', 'Back (←)')}>
            <ChevronLeft size={20} />
          </button>
          <button className="ctrl" onClick={() => setCursor(cursor + 1)} disabled={cursor >= line.length} title={L('Vor (→)', 'Forward (→)')}>
            <ChevronRight size={20} />
          </button>
          <button className="ctrl" onClick={() => setCursor(line.length)} disabled={cursor >= line.length} title={L('Ende', 'End')}>
            <ChevronLast size={20} />
          </button>
          <button className="ctrl" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title={L('Brett drehen', 'Flip board')}>
            <ArrowUpDown size={18} />
          </button>
          {game && (
            <button className="ctrl" onClick={() => navigate('games')} title={L('Alle Partien', 'All games')}>
              <ListOrdered size={18} />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
