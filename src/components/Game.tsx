import { L } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Move } from 'chess.js';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { Board } from './Board';
import { Engine, formatScore, type EngineLine } from '../engine';
import { botLine, chooseBotMove, type Bot } from '../bots';
import {
  CLASS_INFO,
  COACH_INSTRUCTIONS,
  botMovePrompt,
  chatPrompt,
  hintPrompt,
  movePrompt,
  pvToSan,
  reviewMove,
  type GameContext,
  type MoveReview,
} from '../coach';
import { streamCoach, type ChatMsg } from '../api';
import type { CoachSettings } from './AccountBar';
import type { GameSetup } from './Home';
import { playSound } from '../sound';
import { Avatar, Captured, ClassIcon, Markdown, Piece, PlayerBar } from './ui';
import { store, uid, type GameRecord } from '../lib/data';
import { CROWNS, newCrowns, type CrownId } from '../lib/crowns';
import { navigate } from '../router';
import { ArrowLeft, ArrowUpDown, Compass, Crown, ChartNoAxesColumn, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Flag, GraduationCap, Lightbulb, Microscope, Plus, Redo2, RotateCcw, SendHorizontal, Swords, Trophy, Undo2, X } from 'lucide-react';
import { extractMarkers, hideMarkers, resolveVariation, scrollFeedToEnd, useVariationView, type Variation } from '../lib/variation';
import { VariationBar, VariationLine } from './Variation';
import { useExplore } from '../lib/explore';
import { useLiveEval } from '../lib/useLiveEval';
import { ExploreBar, ExplorePanel } from './Explore';
import { BookOpen } from 'lucide-react';
import { bookMove, bookNote, bookState, fitsLine, parseBookLine, type BookLine } from '../lib/book';

type Action = 'retry' | 'showBest' | 'continue';

interface Msg {
  id: number;
  from: 'coach' | 'bot' | 'user';
  text: string;
  review?: MoveReview;
  streaming?: boolean;
  error?: boolean;
  actions?: Action[];
  /** Vom Coach genannte Varianten (zum Durchklicken) */
  variations?: Variation[];
  /** Vom Coach vorgeschlagene Eröffnung, die eine neue Partie braucht */
  newGame?: BookLine;
}

interface Props {
  setup: GameSetup;
  loggedIn: boolean;
  settings: CoachSettings;
  onExit: () => void;
  onRematch: () => void;
  /** Neue Partie gegen denselben Bot mit einer Eröffnungslinie */
  onNewGame?: (line: BookLine) => void;
}

// Tiefe 18: ab hier werden auch Opfer-Kombinationen zuverlässig gesehen (gemessen)
const ANALYSIS_DEPTH = 18;
const ANALYSIS_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;

export function Game({ setup, loggedIn, settings, onExit, onRematch, onNewGame }: Props) {
  const { bot, color: playerColor } = setup;
  const tc = setup.timeControl;
  const timed = !!tc;
  const coach = setup.coach && !timed;
  const chess = useRef(new Chess(setup.startFen));
  const gameId = useRef(uid());
  const counters = useRef({ takebacks: 0, hints: 0 });
  const epoch = useRef(0);
  const engines = useRef<{ bot: Engine; ana: Engine } | null>(null);
  const cache = useRef(new Map<string, Promise<EngineLine[]>>());
  // Laufende Zug-Kommentare (werden beim nächsten Zug abgebrochen); Chat-Antworten laufen weiter
  const moveStreams = useRef(new Set<AbortController>());
  const abortMoveStreams = () => {
    moveStreams.current.forEach((c) => c.abort());
    moveStreams.current.clear();
  };

  const [fen, setFen] = useState(chess.current.fen());
  const [lastMove, setLastMove] = useState<[string, string]>();
  const [moves, setMoves] = useState<Move[]>([]);
  const [reviews, setReviews] = useState<Record<number, MoveReview>>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [evalW, setEvalW] = useState<{ score: number; mate: number | null } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [over, setOver] = useState<{ title: string; reason: string; result: 'win' | 'loss' | 'draw' } | null>(null);
  const [orientation, setOrientation] = useState<'white' | 'black'>(playerColor === 'w' ? 'white' : 'black');
  const [hintLevel, setHintLevel] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [commentAll, setCommentAll] = useState(() => localStorage.getItem('commentAll') !== '0');
  const [explainOpp, setExplainOpp] = useState(() => localStorage.getItem('explainOpp') !== '0');
  const [showEval, setShowEval] = useState(coach);
  const [showModal, setShowModal] = useState(true);
  /** Ansicht einer früheren Stellung (null = aktuelle Stellung) */
  const [viewPly, setViewPly] = useState<number | null>(null);
  /** Zurückgenommene Züge, die wiederholt werden können */
  const redo = useRef<{ sans: string[]; reviews: Record<number, MoveReview> }>({ sans: [], reviews: {} });
  const [redoCount, setRedoCount] = useState(0);
  const vv = useVariationView();
  // Erkunden: freie Züge für beide Seiten mit Live-Bewertung, die Partie bleibt unverändert
  const ex = useExplore();
  const exLast = ex.current ? ex.current.from + ex.current.to + (ex.current.promotion ?? '') : null;
  const exEval = useLiveEval(ex.fen, ex.prevFen, exLast);
  const exRef = useRef({ ex, exEval });
  exRef.current = { ex, exEval };
  // ---------- Schachuhr ----------
  const clock = useRef({ w: (tc?.base ?? 0) * 1000, b: (tc?.base ?? 0) * 1000, turnStart: 0, running: false });
  const [clockView, setClockView] = useState({ w: (tc?.base ?? 0) * 1000, b: (tc?.base ?? 0) * 1000 });
  const moveTimes = useRef<number[]>([]);
  const moveClocks = useRef<number[]>([]);
  const overRef = useRef(false);
  const [gainedCrowns, setGainedCrowns] = useState<CrownId[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);
  // Eröffnungslinie, der der Bot folgt (nur aus der Grundstellung)
  const [book, setBook] = useState<BookLine | null>(setup.startFen ? null : setup.openingLine ?? null);
  const bookRef = useRef(book);
  bookRef.current = book;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const flags = useRef({ commentAll, explainOpp, loggedIn });
  flags.current = { commentAll, explainOpp, loggedIn };

  useEffect(() => { localStorage.setItem('commentAll', commentAll ? '1' : '0'); }, [commentAll]);
  useEffect(() => { localStorage.setItem('explainOpp', explainOpp ? '1' : '0'); }, [explainOpp]);
  useEffect(() => { scrollFeedToEnd(chatEnd.current); }, [msgs]);

  // ---------- Helfer ----------

  const analyze = useCallback((f: string) => {
    let p = cache.current.get(f);
    if (!p) {
      p = engines.current!.ana.analyze(f, { depth: ANALYSIS_DEPTH, movetime: ANALYSIS_MS, multipv: 3 });
      cache.current.set(f, p);
    }
    return p;
  }, []);

  const addMsg = useCallback((m: Omit<Msg, 'id'>) => {
    const id = ++msgId;
    setMsgs((ms) => [...ms, { ...m, id }]);
    return id;
  }, []);
  const patchMsg = useCallback((id: number, p: Partial<Msg>) => setMsgs((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m))), []);

  const updateEval = useCallback(
    (f: string) => {
      if (timed) return;
      const e = epoch.current;
      analyze(f).then((lines) => {
        if (e !== epoch.current || !lines.length || chess.current.fen() !== f) return;
        const sign = f.split(' ')[1] === 'w' ? 1 : -1;
        setEvalW({ score: lines[0].score * sign, mate: lines[0].mate !== null ? lines[0].mate * sign : null });
      });
    },
    [analyze],
  );

  const sync = useCallback(() => {
    const c = chess.current;
    setFen(c.fen());
    const h = c.history({ verbose: true });
    setMoves(h);
    const last = h[h.length - 1];
    setLastMove(last ? [last.from, last.to] : undefined);
    setHintLevel(0);
    setViewPly(null);
    updateEval(c.fen());
  }, [updateEval]);

  const context = useCallback(async (): Promise<GameContext> => {
    const { ex: x, exEval: xe } = exRef.current;
    if (x.active && x.fen) {
      // Der Schüler erkundet gerade hypothetische Züge – der Coach soll genau diese Stellung erklären
      const f = x.fen;
      const xc = new Chess(f);
      const sign = xc.turn() === 'w' ? 1 : -1;
      const fromGame = x.startFen === chess.current.fen();
      return {
        fen: f,
        ascii: xc.ascii(),
        history: fromGame ? [...chess.current.history(), ...x.sans.slice(0, x.idx)] : x.sans.slice(0, x.idx),
        playerColor,
        opponent: `${bot.name} (${bot.rating})`,
        level: bot.rating,
        note: [bookRef.current ? bookNote(bookRef.current, chess.current.history()) : '', L(
          `HINWEIS: Der Schüler ERKUNDET gerade hypothetische Züge, die in der Partie NICHT gespielt wurden: ${x.sans.slice(0, x.idx).join(' ') || '(noch keine)'}. Die Stellung unten ist die erkundete Stellung. Erkläre, was in dieser Variante passiert.`,
          `NOTE: The student is EXPLORING hypothetical moves that were NOT played in the game: ${x.sans.slice(0, x.idx).join(' ') || '(none yet)'}. The position below is the explored position. Explain what happens in this line.`,
        )].filter(Boolean).join('\n'),
        evalText: xe.top ? formatScore(xe.top.cp, xe.top.mate) : undefined,
        topLines: xe.lines.map((l) => `${formatScore(l.score * sign, l.mate !== null ? l.mate * sign : null)}: ${pvToSan(f, l.pv, 6).join(' ')}`),
      };
    }
    const c = chess.current;
    const f = c.fen();
    const lines = await analyze(f);
    const sign = c.turn() === 'w' ? 1 : -1;
    return {
      fen: f,
      ascii: c.ascii(),
      history: c.history(),
      playerColor,
      opponent: `${bot.name} (${bot.rating})`,
      level: bot.rating,
      note: bookRef.current ? bookNote(bookRef.current, c.history()) : undefined,
      evalText: lines[0] ? formatScore(lines[0].score * sign, lines[0].mate !== null ? lines[0].mate * sign : null) : undefined,
      topLines: lines.map((l) => `${formatScore(l.score * sign, l.mate !== null ? l.mate * sign : null)}: ${pvToSan(f, l.pv, 6).join(' ')}`),
    };
  }, [analyze, bot, playerColor]);

  /** Streamt eine Coach-Antwort in eine (neue oder bestehende) Nachricht */
  const askCoach = useCallback(
    async (prompt: string, opts: { msg?: number; history?: ChatMsg[]; review?: MoveReview; drawArrows?: boolean; chat?: boolean } = {}) => {
      if (!flags.current.loggedIn) return;
      const id = opts.msg ?? addMsg({ from: 'coach', text: '', streaming: true, review: opts.review });
      patchMsg(id, { streaming: true });
      const e = epoch.current;
      const ctl = new AbortController();
      if (!opts.chat) moveStreams.current.add(ctl);
      try {
        const { model, effort } = settingsRef.current;
        const full = await streamCoach(
          {
            model,
            effort,
            instructions: COACH_INSTRUCTIONS.replace('{LEVEL}', String(bot.rating)),
            messages: [...(opts.history ?? []), { role: 'user', content: prompt }],
          },
          (t) => patchMsg(id, { text: hideMarkers(t) }),
          ctl.signal,
        );
        const { text, arrows, lines, botLine: spec } = extractMarkers(full);
        // Coach stellt die Eröffnung des Bots um
        const wanted = spec && !setup.startFen ? parseBookLine(spec) : null;
        let newGame: BookLine | undefined;
        if (wanted) {
          if (fitsLine(wanted, chess.current.history()) && chess.current.history().length < wanted.sans.length) setBook(wanted);
          else newGame = wanted;
        }
        // Varianten gegen die passenden Stellungen prüfen (vor/nach dem Zug bzw. aktuelle Stellung)
        const fens = opts.review ? [opts.review.fenBefore, opts.review.fenAfter] : [chess.current.fen()];
        // Varianten, die schon als Engine-Variante unter der Bewertung stehen, nicht doppelt zeigen
        const known = opts.review ? [opts.review.bestPvSan, opts.review.replyPvSan] : [];
        const isKnown = (v: Variation) => known.some((k) => k.length && v.sans.every((s, i) => i >= k.length || s === k[i]) && v.sans[0] === k[0]);
        const variations = lines
          .map((l, i) => resolveVariation(l, fens, lines.length > 1 ? `${L('Coach-Variante', 'Coach line')} ${i + 1}` : L('Coach-Variante', 'Coach line')))
          .filter((v): v is Variation => !!v && !isKnown(v));
        patchMsg(id, { text, streaming: false, variations, newGame });
        if (opts.drawArrows !== false && arrows.length && e === epoch.current)
          setShapes(arrows.map((a) => ({ orig: a.slice(0, 2) as Key, dest: a.slice(2, 4) as Key, brush: 'green' })));
      } catch (err: any) {
        if (err.name === 'AbortError') setMsgs((ms) => ms.flatMap((m) => (m.id !== id ? [m] : m.text || m.review ? [{ ...m, streaming: false }] : [])));
        else patchMsg(id, { text: `${L('Coach nicht erreichbar', 'Coach unavailable')}: ${err.message}`, streaming: false, error: true });
      } finally {
        moveStreams.current.delete(ctl);
      }
    },
    [addMsg, patchMsg, bot.rating, setup.startFen],
  );

  /** Uhr nach einem Zug weiterschalten: Zeit abziehen, Inkrement gutschreiben */
  const punch = useCallback(
    (mover: 'w' | 'b') => {
      if (!tc) return;
      const k = clock.current;
      const now = performance.now();
      let spent = 0;
      if (k.running) {
        spent = now - k.turnStart;
        k[mover] = Math.max(0, k[mover] - spent) + tc.inc * 1000;
      }
      moveTimes.current.push(Math.round(spent));
      moveClocks.current.push(Math.round(k[mover]));
      k.turnStart = now;
      // Die Uhr startet nach dem ersten Zug von Weiß
      k.running = true;
      setClockView({ w: k.w, b: k.b });
    },
    [tc],
  );

  /** Ist die Zeit dieser Seite schon abgelaufen (auch wenn der 100-ms-Tick es noch nicht bemerkt hat)? */
  const outOfTime = useCallback(
    (side: 'w' | 'b') => {
      const k = clock.current;
      return !!tc && k.running && chess.current.turn() === side && k[side] - (performance.now() - k.turnStart) <= 0;
    },
    [tc],
  );

  /** Zeit abgelaufen: Partie beenden */
  const flag = useCallback(
    (loser: 'w' | 'b') => {
      const k = clock.current;
      k[loser] = 0;
      k.running = false;
      epoch.current++;
      setThinking(false);
      setClockView({ w: k.w, b: k.b });
      // Kann der andere überhaupt noch mattsetzen? Sonst Remis
      const pieces = chess.current.board().flat().filter((x) => x && x.color !== loser && x.type !== 'k');
      const canMate = pieces.some((x) => x!.type === 'p' || x!.type === 'q' || x!.type === 'r') || pieces.length >= 2;
      if (!canMate) setOver({ title: L('Remis', 'Draw'), reason: L('Zeit abgelaufen, aber zu wenig Material zum Mattsetzen', 'Time ran out, but not enough material to mate'), result: 'draw' });
      else if (loser === playerColor) setOver({ title: L(`${bot.name} gewinnt`, `${bot.name} wins`), reason: L('durch Zeitüberschreitung', 'on time'), result: 'loss' });
      else setOver({ title: L('Du hast gewonnen!', 'You won!'), reason: L('durch Zeitüberschreitung', 'on time'), result: 'win' });
      setShowModal(true);
      playSound('end');
    },
    [bot.name, playerColor],
  );

  const checkOver = useCallback(() => {
    const c = chess.current;
    if (!c.isGameOver()) return false;
    let title = L('Remis', 'Draw');
    let reason = L('Remis', 'Draw');
    let result: 'win' | 'loss' | 'draw' = 'draw';
    if (c.isCheckmate()) {
      const playerWon = c.turn() !== playerColor;
      result = playerWon ? 'win' : 'loss';
      title = playerWon ? L('Du hast gewonnen!', 'You won!') : L(`${bot.name} gewinnt`, `${bot.name} wins`);
      reason = L('durch Schachmatt', 'by checkmate');
      const l = botLine(bot, playerWon ? 'botLose' : 'botWin');
      if (l) addMsg({ from: 'bot', text: l });
    } else if (c.isStalemate()) reason = L('durch Patt', 'by stalemate');
    else if (c.isThreefoldRepetition()) reason = L('durch dreifache Wiederholung', 'by threefold repetition');
    else if (c.isInsufficientMaterial()) reason = L('durch ungenügendes Material', 'by insufficient material');
    else reason = L('durch 50-Züge-Regel', 'by the 50-move rule');
    setOver({ title, reason, result });
    clock.current.running = false;
    setShowModal(true);
    playSound('end');
    return true;
  }, [addMsg, bot, playerColor]);

  // ---------- Bot ----------

  const botTurn = useCallback(async () => {
    const e = epoch.current;
    const c = chess.current;
    if (c.isGameOver() || c.turn() === playerColor) return;
    setThinking(true);
    const fenBefore = c.fen();
    let budget = 450 + Math.random() * 650;
    if (tc) {
      // Bullet-Bot: denkt grob 1/35 der Restzeit (+ Inkrement), mit etwas Streuung
      const left = clock.current.running ? clock.current[c.turn()] : tc.base * 1000;
      budget = Math.min(2200, Math.max(120, (left / 35 + tc.inc * 700) * (0.6 + Math.random() * 0.8)));
    }
    // Theoriezug aus der gewählten Eröffnung, solange die Partie ihr folgt
    const booked = bookMove(bookRef.current, c.history());
    if (booked) budget = Math.min(budget, tc ? budget : 700);
    const [uci] = await Promise.all([
      booked ? Promise.resolve(booked) : chooseBotMove(engines.current!.bot, fenBefore, bot, { movetime: tc ? Math.max(80, budget * 0.8) : undefined, lastMove: c.history({ verbose: true }).at(-1) }),
      sleep(budget),
    ]);
    if (e !== epoch.current || !uci || overRef.current || c.fen() !== fenBefore) return;
    if (outOfTime(c.turn())) return flag(c.turn());
    setThinking(false);
    let mv: Move;
    try {
      mv = booked ? c.move(booked) : c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return;
    }
    punch(mv.color);
    playSound(mv.captured ? 'capture' : mv.san.includes('+') ? 'check' : 'move');
    sync();
    if (checkOver()) return;

    const isCheck = mv.san.includes('+');
    if (Math.random() < 0.35) {
      const l = botLine(bot, isCheck ? 'check' : mv.captured ? 'capture' : 'think');
      if (l) addMsg({ from: 'bot', text: l });
    }
    // Coach erklärt wichtige Gegnerzüge (Schlagen/Schach)
    if (coach && flags.current.explainOpp && flags.current.loggedIn && (isCheck || mv.captured)) {
      const ctx = await context();
      const lines = await analyze(c.fen());
      if (e !== epoch.current) return;
      askCoach(botMovePrompt(ctx, mv.san, lines[0] ? pvToSan(c.fen(), lines[0].pv, 4) : []), { drawArrows: false });
    }
  }, [addMsg, analyze, askCoach, bot, checkOver, coach, context, flag, outOfTime, playerColor, punch, sync, tc]);

  // ---------- Spieler ----------

  const playerMove = useCallback(
    async (from: string, to: string, promo?: string) => {
      const c = chess.current;
      const e = epoch.current;
      const fenBefore = c.fen();
      if (outOfTime(c.turn())) {
        flag(c.turn());
        sync();
        return;
      }
      let mv: Move;
      try {
        mv = c.move({ from, to, promotion: promo ?? 'q' });
      } catch {
        sync();
        return;
      }
      if (overRef.current) {
        c.undo();
        sync();
        return;
      }
      punch(mv.color);
      abortMoveStreams();
      setShapes([]);
      vv.close();
      redo.current = { sans: [], reviews: {} };
      setRedoCount(0);
      playSound(mv.captured ? 'capture' : mv.san.includes('+') ? 'check' : 'move');
      sync();
      if (checkOver()) return;
      const ply = c.history().length - 1;

      if (!coach) {
        botTurn();
        return;
      }

      const uci = mv.from + mv.to + (mv.promotion ?? '');
      const [before, after] = await Promise.all([analyze(fenBefore), analyze(c.fen())]);
      if (e !== epoch.current || !before.length) {
        botTurn();
        return;
      }
      const review = reviewMove(fenBefore, uci, mv.san, before, after, ply);
      setReviews((r) => ({ ...r, [ply]: review }));
      const bad = ['mistake', 'blunder'].includes(review.classification);
      const meh = review.classification === 'inaccuracy';
      const id = addMsg({ from: 'coach', text: '', review, actions: bad ? ['retry', 'showBest', 'continue'] : undefined });

      if (bad) {
        setPaused(true);
        const l = botLine(bot, 'playerBlunder');
        if (l && review.classification === 'blunder') addMsg({ from: 'bot', text: l });
      }
      if (flags.current.loggedIn && (bad || meh || flags.current.commentAll)) {
        const ctx = await context();
        askCoach(movePrompt(ctx, review), { msg: id, review });
      }
      if (!bad) botTurn();
    },
    [addMsg, analyze, askCoach, bot, botTurn, checkOver, coach, context, flag, outOfTime, punch, sync, vv.close],
  );

  const onBoardMove = useCallback(
    (from: string, to: string) => {
      const p = chess.current.get(from as any);
      if (p?.type === 'p' && (to[1] === '8' || to[1] === '1') && !timed) setPromotion({ from, to });
      else playerMove(from, to);
    },
    [playerMove],
  );

  // ---------- Aktionen ----------

  const undoToPlayer = useCallback(() => {
    const c = chess.current;
    if (c.history().length) counters.current.takebacks++;
    epoch.current++;
    abortMoveStreams();
    setThinking(false);
    setPaused(false);
    setOver(null);
    let undone = 0;
    const taken: string[] = [];
    while (c.history().length && (c.turn() !== playerColor || undone === 0)) {
      taken.unshift(c.undo()!.san);
      undone++;
    }
    const plies = c.history().length;
    setReviews((r) => {
      const keep: Record<number, MoveReview> = {};
      const moved: Record<number, MoveReview> = {};
      for (const [k, v] of Object.entries(r)) (Number(k) < plies ? keep : moved)[Number(k)] = v;
      redo.current = { sans: [...taken, ...redo.current.sans], reviews: { ...redo.current.reviews, ...moved } };
      setRedoCount(redo.current.sans.length);
      return keep;
    });
    setShapes([]);
    vv.close();
    sync();
  }, [playerColor, sync, vv.close]);

  /** Zurückgenommene Züge exakt wiederherstellen (bis du wieder am Zug bist) */
  const redoMoves = useCallback(() => {
    const c = chess.current;
    const r = redo.current;
    if (!r.sans.length) return;
    epoch.current++;
    abortMoveStreams();
    let n = 0;
    while (r.sans.length && (n === 0 || c.turn() !== playerColor)) {
      c.move(r.sans.shift()!);
      n++;
    }
    const plies = c.history().length;
    const restored: Record<number, MoveReview> = {};
    for (const [k, v] of Object.entries(r.reviews)) if (Number(k) < plies) restored[Number(k)] = v;
    setReviews((cur) => ({ ...cur, ...restored }));
    setRedoCount(r.sans.length);
    setPaused(false);
    setShapes([]);
    vv.close();
    playSound('move');
    sync();
    if (checkOver()) return;
    // Nichts mehr zum Wiederholen und der Bot ist dran: weiterspielen
    if (!r.sans.length && c.turn() !== playerColor) botTurn();
  }, [botTurn, checkOver, playerColor, sync, vv.close]);

  const onAction = useCallback(
    (a: Action, review?: MoveReview) => {
      setMsgs((ms) => ms.map((m) => ({ ...m, actions: undefined })));
      if (a === 'continue') {
        setPaused(false);
        setShapes([]);
        botTurn();
        return;
      }
      undoToPlayer();
      addMsg({ from: 'coach', text: a === 'retry' ? L('Okay, versuch es nochmal! Schau genau, was der Gegner droht.', 'Okay, try again! Look closely at what your opponent threatens.') : L(`Besser war ${review?.bestSan}. Probier es aus!`, `${review?.bestSan} was better. Give it a try!`) });
      if (a === 'showBest' && review)
        setShapes([{ orig: review.bestUci.slice(0, 2) as Key, dest: review.bestUci.slice(2, 4) as Key, brush: 'green' }]);
    },
    [addMsg, botTurn, undoToPlayer],
  );

  const hint = useCallback(async () => {
    const c = chess.current;
    if (c.turn() !== playerColor || c.isGameOver()) return;
    const lines = await analyze(c.fen());
    if (!lines.length) return;
    const best = lines[0].pv[0];
    const next = hintLevel + 1;
    setHintLevel(next);
    counters.current.hints++;
    if (next >= 3 || !flags.current.loggedIn) {
      if (next === 1 && !flags.current.loggedIn) {
        setShapes([{ orig: best.slice(0, 2) as Key, brush: 'green' }]);
        addMsg({ from: 'coach', text: L('Schau dir diese Figur genauer an.', 'Take a closer look at this piece.') });
      } else {
        setShapes([{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'green' }]);
        addMsg({ from: 'coach', text: L(`Der stärkste Zug ist ${pvToSan(c.fen(), [best], 1)[0]}.`, `The strongest move is ${pvToSan(c.fen(), [best], 1)[0]}.`) });
      }
      return;
    }
    if (next === 2) setShapes([{ orig: best.slice(0, 2) as Key, brush: 'green' }]);
    askCoach(hintPrompt(await context(), next as 1 | 2), { drawArrows: false });
  }, [addMsg, analyze, askCoach, context, hintLevel, playerColor]);

  const sendChat = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    addMsg({ from: 'user', text: q });
    if (!flags.current.loggedIn) {
      addMsg({ from: 'coach', text: L('Melde dich links unten mit ChatGPT an, damit ich deine Fragen beantworten kann.', 'Sign in with ChatGPT at the bottom left so I can answer your questions.'), error: true });
      return;
    }
    setBusy(true);
    const history: ChatMsg[] = msgs
      .filter((m) => (m.from === 'user' || m.from === 'coach') && m.text && !m.error)
      .slice(-8)
      .map((m) => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.review ? `[${L('Kommentar zu', 'Comment on')} ${m.review.san}] ${m.text}` : m.text }));
    await askCoach(chatPrompt(await context(), q), { history, chat: true });
    setBusy(false);
  }, [addMsg, askCoach, busy, context, input, msgs]);

  const resign = useCallback(() => {
    epoch.current++;
    setThinking(false);
    clock.current.running = false;
    setOver({ title: L(`${bot.name} gewinnt`, `${bot.name} wins`), reason: L('durch Aufgabe', 'by resignation'), result: 'loss' });
    setShowModal(true);
    const l = botLine(bot, 'botWin');
    if (l) addMsg({ from: 'bot', text: l });
  }, [addMsg, bot]);

  const discussGame = useCallback(async () => {
    setShowModal(false);
    const rs = Object.entries(reviews).map(([ply, r]) => `${Math.floor(Number(ply) / 2) + 1}${Number(ply) % 2 ? '...' : '.'} ${r.san}: ${CLASS_INFO[r.classification].label}${r.classification !== 'best' && r.classification !== 'book' ? ` (${L('besser', 'better')} ${r.bestSan})` : ''}`);
    askCoach(
      L(
        `${contextBlock2()}\nErgebnis: ${over?.title} ${over?.reason}\nBewertung meiner Züge:\n${rs.join('\n')}\n\nGib mir eine kurze Partie-Besprechung wie das Game Review auf chess.com: 1) Was lief gut, 2) die 2–3 Schlüsselmomente, 3) ein konkreter Trainingstipp. Max. 150 Wörter.`,
        `${contextBlock2()}\nResult: ${over?.title} ${over?.reason}\nRating of my moves:\n${rs.join('\n')}\n\nGive me a short game review like on the big chess sites: 1) what went well, 2) the 2–3 key moments, 3) one concrete training tip. Max. 150 words.`,
      ),
      { drawArrows: false },
    );
    function contextBlock2() {
      return L(
        `Partie (SAN): ${chess.current.pgn()}\nIch spielte ${playerColor === 'w' ? 'Weiß' : 'Schwarz'} gegen ${bot.name} (${bot.rating}).`,
        `Game (SAN): ${chess.current.pgn()}\nI played ${playerColor === 'w' ? 'White' : 'Black'} against ${bot.name} (${bot.rating}).`,
      );
    }
  }, [askCoach, bot, over, playerColor, reviews]);

  useEffect(() => {
    overRef.current = !!over;
  }, [over]);

  useEffect(() => {
    if (!tc || over) return;
    const id = window.setInterval(() => {
      const k = clock.current;
      if (!k.running) return;
      const side = chess.current.turn();
      const left = k[side] - (performance.now() - k.turnStart);
      setClockView({ ...{ w: k.w, b: k.b }, [side]: Math.max(0, left) });
      if (left <= 0) flag(side);
    }, 100);
    return () => window.clearInterval(id);
  }, [tc, over, flag]);

  // ---------- Start ----------

  useEffect(() => {
    engines.current = { bot: new Engine(), ana: new Engine() };
    const l = botLine(bot, 'greet');
    if (coach) {
      addMsg({
        from: 'coach',
        text: loggedIn
          ? L('Hallo! Ich bin dein Coach. Ich bewerte jeden deiner Züge und erkläre dir, was dahintersteckt. Frag mich jederzeit etwas!', "Hi! I'm your coach. I'll rate every move you make and explain what's behind it. Ask me anything, anytime!")
          : L('Hallo! Ich bewerte deine Züge mit Stockfish. Für echte Erklärungen melde dich links unten mit ChatGPT an.', 'Hi! I rate your moves with Stockfish. For real explanations, sign in with ChatGPT at the bottom left.'),
      });
      if (bot.id !== 'coach' && l) addMsg({ from: 'bot', text: l });
    } else if (l) addMsg({ from: 'bot', text: l });
    if (setup.goal) addMsg({ from: 'coach', text: setup.goal });
    sync();
    if (chess.current.turn() !== playerColor) botTurn();
    return () => {
      epoch.current++;
      abortMoveStreams();
      engines.current?.bot.destroy();
      engines.current?.ana.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Darstellung ----------

  // ← → blättern durch die Partie (bzw. durch eine geöffnete Variante)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (ex.active) {
        ex.go(ex.idx + dir);
        return;
      }
      if (vv.active) {
        vv.go(vv.idx + dir);
        return;
      }
      const total = chess.current.history().length;
      setViewPly((v) => {
        const cur = v ?? total;
        const next = Math.max(0, Math.min(total, cur + dir));
        return next >= total ? null : next;
      });
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [vv, ex]);

  const turn = fen.split(' ')[1] as 'w' | 'b';
  const viewing = viewPly !== null && viewPly < moves.length;
  const canMove = !over && !paused && !thinking && turn === playerColor && !promotion && !viewing && !vv.active && !ex.active;
  const startFen = setup.startFen ?? new Chess().fen();
  const viewFen = viewing ? (viewPly === 0 ? startFen : moves[viewPly! - 1].after) : fen;
  const viewLast = viewing ? (viewPly! > 0 ? ([moves[viewPly! - 1].from, moves[viewPly! - 1].to] as [string, string]) : undefined) : lastMove;
  const boardFen = ex.fen ?? vv.fen ?? viewFen;
  const boardLast = ex.active ? ex.lastMove : vv.active ? vv.lastMove : viewLast;
  const exBest = ex.active ? exEval.lines[0]?.pv[0] : undefined;
  const boardShapes: DrawShape[] = ex.active
    ? exBest
      ? [{ orig: exBest.slice(0, 2) as Key, dest: exBest.slice(2, 4) as Key, brush: 'blue' }]
      : []
    : vv.active
    ? vv.nextArrow
      ? [{ orig: vv.nextArrow[0] as Key, dest: vv.nextArrow[1] as Key, brush: 'paleBlue' }]
      : []
    : viewing
      ? []
      : shapes;
  /** Erkunden ab der gerade angezeigten Stellung (aktuell, früherer Zug oder Variante) */
  const startExplore = () => {
    if (vv.active && vv.variation) {
      ex.open(vv.variation.startFen, vv.variation.sans.slice(0, vv.idx));
      vv.close();
    } else ex.open(viewFen);
    setViewPly(null);
    // Schon gerechnete Bewertung der Ausgangsstellung übernehmen
    analyze(viewing ? viewFen : fen).then((l) => exEval.seed(viewing ? viewFen : fen, l)).catch(() => {});
  };
  const goView = (p: number | null) => {
    vv.close();
    setViewPly(p === null || p >= moves.length ? null : Math.max(0, p));
  };
  const openVariation = (v: Variation, idx: number) => {
    setViewPly(null);
    vv.open(v, idx);
  };
  const accuracy = useMemo(() => {
    const vals = Object.values(reviews);
    if (!vals.length) return null;
    const avg = vals.reduce((a, r) => a + r.winLoss, 0) / vals.length;
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * avg) - 3.1669));
  }, [reviews]);

  // Partie speichern, sobald sie vorbei ist (bei Zurücknahme + neuem Ende wird derselbe Eintrag aktualisiert)
  useEffect(() => {
    if (!over) return;
    const c = chess.current;
    if (c.history().length < 2 && !setup.startFen) return;
    const rec: GameRecord = {
        id: gameId.current,
        date: new Date().toISOString(),
        mode: setup.startFen ? 'practice' : coach ? 'coach' : 'bot',
        botId: bot.id,
        botName: bot.name,
        botRating: bot.rating,
        color: playerColor,
        result: over.result,
        reason: over.reason,
        startFen: setup.startFen,
        sans: c.history(),
        takebacks: counters.current.takebacks,
        hints: counters.current.hints,
        accuracy,
        ...(tc ? { timeControl: tc, times: moveTimes.current, clocks: moveClocks.current } : {}),
      };
    store
      .put('games', rec)
      .then(() => store.list('games'))
      .then((all) => setGainedCrowns(over.result === 'win' ? newCrowns(rec, all) : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);

  const exTop = ex.active ? exEval.top : null;
  const shownEval = ex.active ? (exTop ? { score: exTop.cp, mate: exTop.mate } : null) : evalW;
  const evalPct = shownEval ? (shownEval.mate !== null ? (shownEval.mate > 0 ? 100 : shownEval.mate < 0 ? 0 : shownEval.score > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, shownEval.score)))) - 1)) : 50;
  const evalLabel = shownEval ? (shownEval.mate !== null ? `M${Math.abs(shownEval.mate)}` : (Math.abs(shownEval.score) / 100).toFixed(1)) : '0.0';
  const top: 'w' | 'b' = orientation === 'white' ? 'b' : 'w';
  const bottom: 'w' | 'b' = top === 'w' ? 'b' : 'w';

  // Plakette auf dem letzten bewerteten Zug des Spielers, solange die Figur dort steht
  const lastPly = moves.length - 1;
  const badgePly = reviews[lastPly] ? lastPly : reviews[lastPly - 1] && moves[lastPly]?.to !== moves[lastPly - 1]?.to ? lastPly - 1 : -1;
  const badge = ex.active
    ? ex.current && exEval.lastClass
      ? { square: ex.current.to, c: exEval.lastClass.c }
      : undefined
    : badgePly >= 0 && !viewing && !vv.active
      ? { square: moves[badgePly].to, c: reviews[badgePly].classification }
      : undefined;

  const pairs: [Move, Move | undefined, number][] = [];
  for (let i = 0; i < moves.length; i += 2) pairs.push([moves[i], moves[i + 1], i]);

  const bar = (side: 'w' | 'b') =>
    side === playerColor ? (
      <PlayerBar avatar="you" name={L('Du', 'You')} active={turn === side && !over} right={tc && <Clock ms={clockView[side]} active={turn === side && !over && clock.current.running} />}>
        <div className="bar-sub">
          <Captured moves={moves} side={side} />
          {accuracy !== null && <span className="acc">{accuracy.toFixed(1)} % {L('Genauigkeit', 'accuracy')}</span>}
        </div>
      </PlayerBar>
    ) : (
      <PlayerBar avatar={bot.id} name={bot.name} rating={bot.rating} active={turn === side && !over} right={tc && <Clock ms={clockView[side]} active={turn === side && !over && clock.current.running} />}>
        <div className="bar-sub">
          <Captured moves={moves} side={side} />
          {thinking && (
            <span className="thinking">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      </PlayerBar>
    );

  return (
    <div className="layout">
      <div className="board-col">
        {ex.active ? <ExploreBar ex={ex} onClose={ex.close} /> : vv.active ? <VariationBar vv={vv} onExplore={!timed ? startExplore : undefined} /> : bar(top)}
        <div className="board-row">
          {(showEval || ex.active) && (
            <div className={`evalbar ${orientation === 'black' ? 'flip' : ''}`}>
              <div className="white" style={{ height: `${evalPct}%` }} />
              <span className={evalPct >= 50 ? 'lbl bottom' : 'lbl top'}>{evalLabel}</span>
            </div>
          )}
          <div className="board-wrap">
            <Board
              fen={boardFen}
              orientation={orientation}
              movable={canMove ? (playerColor === 'w' ? 'white' : 'black') : null}
              lastMove={boardLast}
              shapes={boardShapes}
              onMove={(f, t) => {
                if (ex.active) {
                  const m = ex.play(f, t);
                  if (m) playSound(m.captured ? 'capture' : m.san.includes('+') ? 'check' : 'move');
                } else onBoardMove(f, t);
              }}
              movableOverride={ex.active ? 'both' : undefined}
              badge={badge}
              premoveColor={timed && !over && !viewing && !vv.active && !ex.active ? (playerColor === 'w' ? 'white' : 'black') : null}
            />
            {viewing && !vv.active && !ex.active && (
              <button className="view-pill" onClick={() => goView(null)}>
                {L('Du siehst Zug', 'Viewing move')} {Math.ceil(viewPly! / 2) || 0} · <b>{L('Zurück zur aktuellen Stellung', 'Back to current position')}</b> <ChevronLast size={15} />
              </button>
            )}
            {promotion && (
              <div className="promo">
                <div className="promo-card">
                  {(['q', 'r', 'b', 'n'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        const pr = promotion;
                        setPromotion(null);
                        playerMove(pr.from, pr.to, p);
                      }}
                    >
                      <Piece type={p} color={playerColor} size={64} />
                    </button>
                  ))}
                  <button className="promo-x" onClick={() => (setPromotion(null), sync())} title={L('Abbrechen', 'Cancel')}>
                    <X size={20} />
                  </button>
                </div>
              </div>
            )}
            {over && showModal && (
              <div className="over">
                <div className="over-card">
                  <button className="over-close" onClick={() => setShowModal(false)} title={L('Brett ansehen', 'View board')}>
                    <X size={18} />
                  </button>
                  <div className="over-head">
                    <Trophy size={26} />
                    <h2>{over.title}</h2>
                    <p>{over.reason}</p>
                  </div>
                  {gainedCrowns.length > 0 && (
                    <div className="crown-gain">
                      {gainedCrowns.map((id) => {
                        const c = CROWNS.find((x) => x.id === id)!;
                        return (
                          <div key={id}>
                            <Crown size={22} fill="currentColor" />
                            <span>
                              <b>{L('Neue Krone', 'New crown')}: {c.label}</b>
                              <small>{c.desc}</small>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="over-vs">
                    <div>
                      <Avatar id="you" size={64} />
                      <span>{L('Du', 'You')}</span>
                    </div>
                    <b>vs</b>
                    <div>
                      <Avatar id={bot.id} size={64} />
                      <span>{bot.name}</span>
                    </div>
                  </div>
                  {accuracy !== null && (
                    <div className="over-acc">
                      <span>{L('Genauigkeit', 'Accuracy')}</span>
                      <b>{accuracy.toFixed(1)}</b>
                    </div>
                  )}
                  <div className="over-btns">
                    {loggedIn && Object.keys(reviews).length > 0 && (
                      <button className="btn primary block" onClick={discussGame}>
                        <GraduationCap size={18} /> {L('Partie besprechen', 'Review with coach')}
                      </button>
                    )}
                    <button className="btn block" onClick={() => navigate(`analysis/${gameId.current}`)}>
                      <Microscope size={16} /> {L('Partie analysieren', 'Analyze game')}
                    </button>
                    <div className="over-row">
                      <button className="btn block" onClick={onRematch}>
                        <RotateCcw size={16} /> {L('Revanche', 'Rematch')}
                      </button>
                      <button className="btn block" onClick={onExit}>
                        <Plus size={16} /> {L('Neuer Gegner', 'New opponent')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        {bar(bottom)}
      </div>

      <section className="panel game-panel">
        <header className="panel-head">
          {coach ? <GraduationCap size={22} /> : <Swords size={20} />}
          <h1>{coach ? 'Coach' : L(`Gegen ${bot.name}`, `vs ${bot.name}`)}</h1>
          {coach && <span className="head-meta">{loggedIn ? settings.model : L('nur Engine', 'engine only')}</span>}
        </header>

        {book && !ex.active && <BookChip line={book} history={moves.map((m) => m.san)} onClear={() => setBook(null)} />}
        <ExplorePanel ex={ex} lines={exEval.lines} top={exEval.top} lastClass={exEval.lastClass} />
        <div className="feed">
          {msgs.map((m) => (
            <div key={m.id} className={`msg ${m.from} ${m.error ? 'error' : ''}`}>
              {m.from !== 'user' && <Avatar id={m.from === 'coach' ? 'coach' : bot.id} size={36} />}
              <div className="bubble">
                {m.review && <ReviewHead r={m.review} onOpen={openVariation} vv={vv} />}
                {m.text && <div className="text"><Markdown text={m.text} /></div>}
                {m.variations?.map((v, i) => <VariationLine key={i} v={v} onOpen={openVariation} active={vv.variation === v} activeIdx={vv.idx} />)}
                {m.newGame && onNewGame && (
                  <div className="actions">
                    <button className="btn primary small" onClick={() => onNewGame(m.newGame!)}>
                      <BookOpen size={15} /> {L(`Neue Partie: ${m.newGame.name}`, `New game: ${m.newGame.name}`)}
                    </button>
                  </div>
                )}
                {m.streaming && !m.text && (
                  <div className="typing">
                    <i />
                    <i />
                    <i />
                  </div>
                )}
                {m.actions && (
                  <div className="actions">
                    {m.actions.includes('retry') && (
                      <button className="btn primary small" onClick={() => onAction('retry', m.review)}>
                        <Undo2 size={15} /> {L('Nochmal versuchen', 'Try again')}
                      </button>
                    )}
                    {m.actions.includes('showBest') && (
                      <button className="btn small" onClick={() => onAction('showBest', m.review)}>
                        {L('Besten Zug zeigen', 'Show best move')}
                      </button>
                    )}
                    {m.actions.includes('continue') && (
                      <button className="btn ghost small" onClick={() => onAction('continue', m.review)}>
                        {L('Weiterspielen', 'Continue')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={chatEnd} />
        </div>

        {coach && (
          <form
            className="ask"
            onSubmit={(e) => {
              e.preventDefault();
              sendChat();
            }}
          >
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={loggedIn ? L('Frag den Coach …', 'Ask the coach …') : L('Anmelden, um Fragen zu stellen', 'Sign in to ask questions')} disabled={!loggedIn} />
            <button className="send" disabled={busy || !input.trim()} title={L('Senden', 'Send')}>
              <SendHorizontal size={18} />
            </button>
          </form>
        )}

        <div className="moves">
          {pairs.length === 0 && <div className="moves-empty">{L('Noch keine Züge', 'No moves yet')}</div>}
          {pairs.map(([w, b, i]) => (
            <div className="move-row" key={i}>
              <span className="num">{i / 2 + 1}.</span>
              <MoveCell mv={w} r={reviews[i]} current={(viewing ? viewPly! - 1 : lastPly) === i} onClick={() => goView(i + 1)} />
              {b ? <MoveCell mv={b} r={reviews[i + 1]} current={(viewing ? viewPly! - 1 : lastPly) === i + 1} onClick={() => goView(i + 2)} /> : <span />}
            </div>
          ))}
        </div>
        <div className="nav-bar game-nav">
          <button className="ctrl" onClick={() => goView(0)} disabled={!moves.length || viewPly === 0} title={L('Zum Anfang', 'To the start')}>
            <ChevronFirst size={19} />
          </button>
          <button className="ctrl" onClick={() => goView((viewing ? viewPly! : moves.length) - 1)} disabled={!moves.length || viewPly === 0} title={L('Einen Zug zurück ansehen (←)', 'View one move back (←)')}>
            <ChevronLeft size={19} />
          </button>
          <button className="ctrl" onClick={() => goView(viewing ? viewPly! + 1 : null)} disabled={!viewing} title={L('Einen Zug vor (→)', 'One move forward (→)')}>
            <ChevronRight size={19} />
          </button>
          <button className="ctrl" onClick={() => goView(null)} disabled={!viewing} title={L('Zur aktuellen Stellung', 'To the current position')}>
            <ChevronLast size={19} />
          </button>
        </div>

        <div className="controls">
          {coach && (
            <button className="ctrl hint" onClick={hint} disabled={!canMove}>
              <Lightbulb size={20} />
              <span>{L('Hinweis', 'Hint')}{hintLevel ? ` ${Math.min(hintLevel + 1, 3)}/3` : ''}</span>
            </button>
          )}
          {!timed && (<>
          <button className="ctrl" onClick={undoToPlayer} disabled={!moves.length} title={L('Deinen letzten Zug zurücknehmen', 'Take back your last move')}>
            <Undo2 size={20} />
            <span>{L('Zurücknehmen', 'Take back')}</span>
          </button>
          <button className="ctrl" onClick={redoMoves} disabled={!redoCount} title={L('Zurückgenommene Züge wiederherstellen', 'Restore taken-back moves')}>
            <Redo2 size={20} />
            <span>{L('Wiederholen', 'Redo')}</span>
          </button>
          </>)}
          {!timed && (
            <button
              className={`ctrl ${ex.active ? 'on' : ''}`}
              onClick={() => (ex.active ? ex.close() : startExplore())}
              disabled={thinking && !ex.active}
              title={L('Von hier aus frei für beide Seiten ziehen und die Bewertung sehen – die Partie bleibt unverändert', 'Move both sides freely from here and watch the evaluation – the game stays unchanged')}
            >
              <Compass size={20} />
              <span>{ex.active ? L('Beenden', 'Stop') : L('Erkunden', 'Explore')}</span>
            </button>
          )}
          <button className="ctrl" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}>
            <ArrowUpDown size={20} />
            <span>{L('Drehen', 'Flip')}</span>
          </button>
          <button className={`ctrl ${showEval ? 'on' : ''}`} onClick={() => setShowEval(!showEval)}>
            <ChartNoAxesColumn size={20} />
            <span>{L('Bewertung', 'Eval')}</span>
          </button>
          {!over ? (
            <button className="ctrl" onClick={resign} disabled={!moves.length}>
              <Flag size={20} />
              <span>{L('Aufgeben', 'Resign')}</span>
            </button>
          ) : (
            <button className="ctrl" onClick={onRematch}>
              <RotateCcw size={20} />
              <span>{L('Neu', 'New')}</span>
            </button>
          )}
        </div>

        <footer className="game-foot">
          {coach && (
            <>
              <label className="mini-switch">
                <input type="checkbox" className="switch sm" checked={commentAll} onChange={(e) => setCommentAll(e.target.checked)} />
                {L('Jeden Zug erklären', 'Explain every move')}
              </label>
              <label className="mini-switch">
                <input type="checkbox" className="switch sm" checked={explainOpp} onChange={(e) => setExplainOpp(e.target.checked)} />
                {L('Gegnerzüge erklären', "Explain opponent's moves")}
              </label>
            </>
          )}
          <button className="link-btn back" onClick={onExit}>
            <ArrowLeft size={14} /> {L('Menü', 'Menu')}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ReviewHead({ r, onOpen, vv }: { r: MoveReview; onOpen: (v: Variation, idx: number) => void; vv: ReturnType<typeof useVariationView> }) {
  const ci = CLASS_INFO[r.classification];
  const showBetter = !['best', 'book', 'great', 'excellent'].includes(r.classification);
  const better = useMemo<Variation | null>(() => (showBetter && r.bestPvSan.length ? { startFen: r.fenBefore, sans: r.bestPvSan, title: L(`Besser: ${r.bestSan}`, `Better: ${r.bestSan}`) } : null), [r, showBetter]);
  const threat = useMemo<Variation | null>(
    () => (['inaccuracy', 'mistake', 'blunder'].includes(r.classification) && r.replyPvSan.length ? { startFen: r.fenAfter, sans: r.replyPvSan, title: L('Was jetzt droht', 'What it threatens now') } : null),
    [r],
  );
  return (
    <div className="review">
      <ClassIcon c={r.classification} size={22} />
      <span className="review-text">
        <b>{r.san}</b> <span style={{ color: ci.color }}>{ci.label}</span>
      </span>
      <span className="eval-pill">{r.evalAfter}</span>
      {showBetter && r.bestSan && (
        <div className="review-better">
          {L('Besser war', 'Better was')} <b>{r.bestSan}</b>
        </div>
      )}
      {better && <VariationLine v={better} onOpen={onOpen} active={vv.variation === better} activeIdx={vv.idx} />}
      {threat && <VariationLine v={threat} onOpen={onOpen} active={vv.variation === threat} activeIdx={vv.idx} />}
    </div>
  );
}

function MoveCell({ mv, r, current, onClick }: { mv: Move; r?: MoveReview; current?: boolean; onClick?: () => void }) {
  return (
    <span className={`mv clickable ${current ? 'current' : ''}`} onClick={onClick}>
      {r && <ClassIcon c={r.classification} size={15} />}
      {mv.san}
    </span>
  );
}

function Clock({ ms, active }: { ms: number; active: boolean }) {
  const low = ms < 10_000;
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const sec = Math.floor((t % 60000) / 1000);
  const tenth = Math.floor((t % 1000) / 100);
  return (
    <div className={`clock ${active ? 'running' : ''} ${low ? 'low' : ''}`}>
      {m}:{String(sec).padStart(2, '0')}
      {t < 20_000 && <small>.{tenth}</small>}
    </div>
  );
}

/** Zeigt, welcher Eröffnung der Bot folgt und ob die Partie noch in der Theorie ist */
function BookChip({ line, history, onClear }: { line: BookLine; history: string[]; onClear: () => void }) {
  const st = bookState(line, history);
  const moveNo = (ply: number) => `${Math.floor(ply / 2) + 1}.${ply % 2 ? '..' : ''}`;
  return (
    <div className={`book-chip ${st.kind === 'following' ? '' : 'left'}`}>
      <BookOpen size={18} />
      <div>
        <b>{line.name}</b>
        <span>
          {st.kind === 'following'
            ? L(`In der Theorie · Theoriezug: ${moveNo(history.length)} ${st.next}`, `In theory · book move: ${moveNo(history.length)} ${st.next}`)
            : st.kind === 'done'
              ? L('Theorie-Linie zu Ende – ab hier spielt der Bot frei', 'End of the line – the bot plays freely from here')
              : L(`Theorie verlassen bei ${moveNo(st.ply)} ${history[st.ply]} (Theorie: ${line.sans[st.ply]})`, `Left theory at ${moveNo(st.ply)} ${history[st.ply]} (book: ${line.sans[st.ply]})`)}
        </span>
      </div>
      <button className="icon-btn" onClick={onClear} title={L('Eröffnung abwählen', 'Clear opening')}>
        <X size={14} />
      </button>
    </div>
  );
}
