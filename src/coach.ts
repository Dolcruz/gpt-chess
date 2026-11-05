import { Chess } from 'chess.js';
import { openingCatalog } from './lib/book';
import { formatScore, winPercent, type EngineLine } from './engine';
import { L, lang } from './i18n';

export type Classification = 'book' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'great';

export const CLASS_INFO: Record<Classification, { label: string; icon: string; color: string }> = {
  great: { label: L('Großartiger Zug', 'Great move'), icon: '!', color: '#749bbf' },
  best: { label: L('Bester Zug', 'Best move'), icon: '', color: '#81b64c' },
  excellent: { label: L('Exzellent', 'Excellent'), icon: '', color: '#96bc4b' },
  good: { label: L('Gut', 'Good'), icon: '', color: '#95af8a' },
  book: { label: L('Theoriezug', 'Book move'), icon: '', color: '#a88865' },
  inaccuracy: { label: L('Ungenauigkeit', 'Inaccuracy'), icon: '?!', color: '#f7c045' },
  mistake: { label: L('Fehler', 'Mistake'), icon: '?', color: '#ffa459' },
  blunder: { label: L('Patzer', 'Blunder'), icon: '??', color: '#fa412d' },
};

export interface MoveReview {
  san: string;
  uci: string;
  classification: Classification;
  /** Verlust an Gewinnwahrscheinlichkeit in Prozentpunkten */
  winLoss: number;
  evalBefore: string;
  evalAfter: string;
  bestUci: string;
  bestSan: string;
  bestPvSan: string[];
  /** Beste Antwort des Gegners nach dem gespielten Zug */
  replyPvSan: string[];
  alternatives: { san: string; eval: string }[];
  fenBefore: string;
  fenAfter: string;
}

/** UCI-Variante in SAN umwandeln */
export function pvToSan(fen: string, pv: string[], max = 6): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Bewertet den Zug des Spielers.
 * before: Analyse vor dem Zug (Sicht Spieler), after: Analyse danach (Sicht Gegner).
 */
export function reviewMove(fenBefore: string, uci: string, san: string, before: EngineLine[], after: EngineLine[], ply: number): MoveReview {
  const best = before[0];
  const fenAfter = (() => {
    const c = new Chess(fenBefore);
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return c.fen();
  })();
  // Nach dem Zug ist der Gegner am Zug -> Vorzeichen drehen.
  // Keine Engine-Zeilen danach: Matt (Bewertung bleibt) oder Patt (Remis = 0, z. B. ein Patzer aus Gewinnstellung)
  const afterScore = after.length ? -after[0].score : new Chess(fenAfter).isCheckmate() ? best.score : 0;
  const afterMate = after.length && after[0].mate !== null ? -after[0].mate : null;
  const winLoss = Math.max(0, winPercent(best.score) - winPercent(afterScore));
  const isBest = best.pv[0] === uci;
  const secondGap = before[1] ? winPercent(best.score) - winPercent(before[1].score) : 0;

  let classification: Classification;
  if (isBest && secondGap > 15 && winPercent(afterScore) > 30) classification = 'great';
  else if (isBest) classification = ply < 10 && Math.abs(best.score) < 60 ? 'book' : 'best';
  else if (winLoss < 2) classification = 'excellent';
  else if (winLoss < 5) classification = 'good';
  else if (winLoss < 10) classification = 'inaccuracy';
  else if (winLoss < 20) classification = 'mistake';
  else classification = 'blunder';

  return {
    san,
    uci,
    classification,
    winLoss,
    evalBefore: formatScore(best.score, best.mate),
    evalAfter: formatScore(afterScore, afterMate),
    bestUci: best.pv[0],
    bestSan: pvToSan(fenBefore, best.pv, 1)[0] ?? '',
    bestPvSan: pvToSan(fenBefore, best.pv),
    replyPvSan: after.length ? pvToSan(fenAfter, after[0].pv, 5) : [],
    alternatives: before.slice(0, 3).map((l) => ({ san: pvToSan(fenBefore, l.pv, 1)[0] ?? '?', eval: formatScore(l.score, l.mate) })),
    fenBefore,
    fenAfter,
  };
}

// ---------- Prompting ----------

const EN = lang === 'en';

const BOT_LINE_RULES = EN
  ? `- You CAN steer the bot's opening! If the student asks for a specific opening or line (e.g. "play the Scandinavian", "let's try the King's Gambit", "play 3...Bb4 against me"), NEVER say that's impossible. Briefly confirm, explain the idea of the opening in 1–2 sentences, and output on its own line: "BOT_LINE: <id>" for a known opening or "BOT_LINE: <name> | <SAN moves from the starting position for BOTH sides, without move numbers>" for any other line (max. 20 half-moves, only correct theory). The bot then plays its moves from this line as long as the game follows it. If the current game has already left that line, the app offers the student a button for a new game. Do NOT output BOT_LINE unless the student asked for it.
- Known opening ids: ${openingCatalog()}`
  : `- Du KANNST die Eröffnung des Bots steuern! Wenn der Schüler eine bestimmte Eröffnung oder Linie wünscht (z. B. „spiel Skandinavisch“, „lass uns mal Königsgambit probieren“, „spiel gegen mich 3...Bb4“), sag NIE, dass das nicht geht. Bestätige kurz, erkläre die Idee der Eröffnung in 1–2 Sätzen und gib in einer eigenen Zeile aus: "BOT-LINIE: <id>" für eine bekannte Eröffnung oder "BOT-LINIE: <Name> | <SAN-Züge ab Grundstellung für BEIDE Seiten, ohne Zugnummern>" für jede andere Linie (max. 20 Halbzüge, nur korrekte Theorie). Der Bot spielt dann seine Züge aus dieser Linie, solange die Partie ihr folgt. Ist die laufende Partie schon von der Linie abgewichen, bietet die App dem Schüler einen Knopf für eine neue Partie an. Gib BOT-LINIE NUR aus, wenn der Schüler danach gefragt hat.
- Bekannte Eröffnungs-IDs: ${openingCatalog()}`;

const BEGINNER_RULES = EN
  ? `- The student is still a beginner and finds notation hard to read: for every move, name the piece in words, e.g. "knight to f3 (Nf3)" or "bishop takes on f7 with check (Bxf7+)".
- When you describe a continuation, alternative or threat, ADDITIONALLY output it machine-readably on its own line: "VARIATION: Nf3 Nc6 d4" (SAN without move numbers, max. 8 half-moves, only moves from the provided data). At most 2 such lines. The student can click through them on the board move by move.`
  : `- Der Schüler ist noch Anfänger und liest Notation schwer: Nenne bei jedem Zug die Figur in Worten, z. B. „Springer nach f3 (Nf3)“ oder „Läufer schlägt auf f7 mit Schach (Bxf7+)“.
- Wenn du eine Fortsetzung, Alternative oder Drohung beschreibst, gib sie ZUSÄTZLICH in einer eigenen Zeile maschinenlesbar aus: "VARIANTE: Nf3 Nc6 d4" (SAN ohne Zugnummern, max. 8 Halbzüge, nur Züge aus den mitgelieferten Daten). Höchstens 2 solche Zeilen. Der Schüler kann sie auf dem Brett Zug für Zug durchklicken.`;

export const COACH_INSTRUCTIONS = EN
  ? `You are "Coach", a friendly, motivating chess trainer – like the coach mode on the big chess sites.
You accompany the student during a game against a bot. Always answer in English.

Rules:
- Evaluations and variations come EXCLUSIVELY from the provided Stockfish data. Don't invent moves; check every claim against the position (FEN/diagram).
- Explain the IDEA behind moves: threats, hanging pieces, tactics (fork, pin, skewer, discovered attack), king safety, development, center, pawn structure, plans.
- Adapt your language to the student's level (about {LEVEL} Elo). Don't throw engine numbers around unless they help ("you're clearly better").
- Notation: moves in SAN (e.g. Nf3, Bxe5, O-O).
- Keep it short: move comments 1–3 sentences. Chat questions may get longer answers (max. ~120 words).
- For hints, do NOT reveal the move – only hint at the idea or the area.
${BEGINNER_RULES}
${BOT_LINE_RULES}
- Optionally, at the very end you may output ONE line "ARROWS: e2e4 g1f3" (max. 3, UCI format) to draw arrows on the board. Green = good. Only squares/moves that make sense in the position.`
  : `Du bist "Coach", ein freundlicher, motivierender Schachtrainer – so wie der Coach-Modus auf chess.com.
Du begleitest den Schüler während einer Partie gegen einen Bot und sprichst ihn mit "du" an.

Regeln:
- Bewertungen und Varianten kommen AUSSCHLIESSLICH aus den mitgelieferten Stockfish-Daten. Erfinde keine Züge, prüfe Behauptungen gegen die Brettstellung (FEN/Diagramm).
- Erkläre die IDEE hinter Zügen: Drohungen, hängende Figuren, Taktiken (Gabel, Fesselung, Spieß, Abzug), Königssicherheit, Entwicklung, Zentrum, Bauernstruktur, Pläne.
- Passe die Sprache an das Niveau des Schülers an (ca. {LEVEL} Elo). Keine Engine-Zahlen auswerfen, außer sie helfen ("du stehst klar besser").
- Notation: deutsche Sprache, aber Züge in SAN mit englischen Figurenbuchstaben (z. B. Nf3, Bxe5, O-O).
- Halte dich kurz: Zugkommentare 1–3 Sätze. Bei Fragen im Chat darfst du ausführlicher sein (max. ~120 Wörter).
- Bei Hinweisen den Zug NICHT verraten, nur die Idee/den Bereich andeuten.
${BEGINNER_RULES}
${BOT_LINE_RULES}
- Optional darfst du ganz am Ende EINE Zeile "PFEILE: e2e4 g1f3" ausgeben (max. 3, UCI-Format), um Pfeile aufs Brett zu zeichnen. Grün = gut. Nur Felder/Züge, die in der Stellung Sinn ergeben.`;

export interface GameContext {
  fen: string;
  ascii: string;
  history: string[];
  playerColor: 'w' | 'b';
  opponent: string;
  level: number;
  evalText?: string;
  topLines?: string[];
  /** Zusatzhinweis, z. B. dass gerade hypothetische Züge erkundet werden */
  note?: string;
}

const side = (c: 'w' | 'b') => (c === 'w' ? L('Weiß', 'White') : L('Schwarz', 'Black'));

export function contextBlock(ctx: GameContext) {
  const moves = ctx.history.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');
  return [
    ctx.note ?? '',
    L(`Schüler spielt: ${side(ctx.playerColor)} gegen ${ctx.opponent}`, `Student plays: ${side(ctx.playerColor)} against ${ctx.opponent}`),
    L(`Partie bisher: ${moves || '(noch keine Züge)'}`, `Game so far: ${moves || '(no moves yet)'}`),
    L(`Aktuelle Stellung (FEN): ${ctx.fen}`, `Current position (FEN): ${ctx.fen}`),
    L(`Diagramm (Großbuchstaben = Weiß):\n${ctx.ascii}`, `Diagram (uppercase = White):\n${ctx.ascii}`),
    ctx.evalText ? L(`Stockfish-Bewertung (Sicht Weiß): ${ctx.evalText}`, `Stockfish evaluation (White's view): ${ctx.evalText}`) : '',
    ctx.topLines?.length ? L(`Stockfish beste Fortsetzungen:\n${ctx.topLines.join('\n')}`, `Stockfish best continuations:\n${ctx.topLines.join('\n')}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function movePrompt(ctx: GameContext, r: MoveReview) {
  const ci = CLASS_INFO[r.classification];
  const bad = ['inaccuracy', 'mistake', 'blunder'].includes(r.classification);
  if (EN)
    return `${contextBlock(ctx)}

The student just played ${r.san} (the position above is AFTER the move).
Engine verdict: ${ci.label} (loss ≈ ${r.winLoss.toFixed(1)} percentage points of winning chance)
Evaluation before: ${r.evalBefore}, after: ${r.evalAfter} (both from the student's view)
Best move would have been: ${r.bestSan} – line: ${r.bestPvSan.join(' ')}
Top candidates before: ${r.alternatives.map((a) => `${a.san} (${a.eval})`).join(', ')}
Opponent's best reply now: ${r.replyPvSan.join(' ') || '–'}

Comment on the move briefly like a coach. ${
      bad
        ? `Explain concretely WHAT the problem is (e.g. what the opponent now threatens with ${r.replyPvSan[0] ?? 'their reply'}) and why ${r.bestSan} was better. Output the better continuation as a VARIATION from the position BEFORE the student's move (starting with ${r.bestSan}) and – if helpful – the opponent's reply to the played move as a second VARIATION from the current position.`
        : 'Praise briefly and explain the idea or what the student should watch out for next.'
    }`;
  return `${contextBlock(ctx)}

Der Schüler hat gerade ${r.san} gespielt (Stellung oben ist NACH dem Zug).
Engine-Einstufung: ${ci.label} (Verlust ≈ ${r.winLoss.toFixed(1)} Prozentpunkte Gewinnchance)
Bewertung vorher: ${r.evalBefore}, nachher: ${r.evalAfter} (jeweils Sicht des Schülers)
Bester Zug wäre gewesen: ${r.bestSan} – Variante: ${r.bestPvSan.join(' ')}
Top-Kandidaten vorher: ${r.alternatives.map((a) => `${a.san} (${a.eval})`).join(', ')}
Beste Antwort des Gegners jetzt: ${r.replyPvSan.join(' ') || '–'}

Kommentiere den Zug kurz wie ein Coach. ${
    bad
      ? `Erkläre konkret, WAS das Problem ist (z. B. was der Gegner jetzt mit ${r.replyPvSan[0] ?? 'seiner Antwort'} droht) und warum ${r.bestSan} besser war. Gib die bessere Fortsetzung als VARIANTE ab der Stellung VOR dem Zug des Schülers aus (beginnend mit ${r.bestSan}) und – falls hilfreich – die Antwort des Gegners auf den gespielten Zug als zweite VARIANTE ab der aktuellen Stellung.`
      : 'Lobe kurz und erkläre die Idee oder worauf der Schüler als Nächstes achten sollte.'
  }`;
}

export function hintPrompt(ctx: GameContext, level: 1 | 2) {
  if (EN)
    return `${contextBlock(ctx)}

The student is to move and asks for a ${level === 1 ? 'small hint. Do NOT reveal the move – only name the idea, the motif or which piece/area is interesting. No arrows.' : 'clearer hint: name the piece that should move and the idea, but not the destination square yet.'}`;
  return `${contextBlock(ctx)}

Der Schüler ist am Zug und bittet um einen ${level === 1 ? 'kleinen Hinweis. Verrate den Zug NICHT – nenne nur die Idee, das Motiv oder welche Figur/welcher Bereich interessant ist. Keine Pfeile.' : 'deutlicheren Hinweis: Nenne die Figur, die ziehen sollte, und die Idee, aber noch nicht das Zielfeld.'}`;
}

export function chatPrompt(ctx: GameContext, question: string) {
  return `${contextBlock(ctx)}

${L('Frage des Schülers', "Student's question")}: ${question}`;
}

export function botMovePrompt(ctx: GameContext, botSan: string, threatPv: string[]) {
  if (EN)
    return `${contextBlock(ctx)}

The opponent (${ctx.opponent}) just played ${botSan}. Engine main line for the student now: ${threatPv.join(' ') || '–'}
Explain in 1–2 sentences what the opponent is planning or threatening with ${botSan}, so the student stays alert. Don't reveal the best reply directly.`;
  return `${contextBlock(ctx)}

Der Gegner (${ctx.opponent}) hat gerade ${botSan} gespielt. Engine-Hauptvariante für den Schüler jetzt: ${threatPv.join(' ') || '–'}
Erkläre in 1–2 Sätzen, was der Gegner mit ${botSan} vorhat bzw. droht, damit der Schüler aufpasst. Verrate den besten Antwortzug nicht direkt.`;
}

export const TRAINER_INSTRUCTIONS = EN
  ? `You are "Coach", a friendly, precise chess trainer like on the big chess sites. You help the student train: tactics puzzles, lessons, openings and game reviews. Always answer in English.

Rules:
- Evaluations and variations come EXCLUSIVELY from the provided data (Stockfish, solution moves, theory lines). Don't invent moves and check claims against the position (FEN/diagram).
- Explain the IDEA: threats, motifs (fork, pin, skewer, discovered attack, deflection, overloading …), plans, typical mistakes.
- Student level: about {LEVEL} Elo. Clear, short sentences. Moves in SAN (Nf3, Bxe5, O-O).
- Keep it short (usually 2–5 sentences) unless the student explicitly wants a detailed explanation or lesson.
- When asked for a hint: don't reveal the move, only hint at the idea.
${BEGINNER_RULES}
- Optionally, at the very end you may output ONE line "ARROWS: e2e4 g1f3" (max. 3, UCI format) to draw arrows on the board.`
  : `Du bist "Coach", ein freundlicher, präziser Schachtrainer wie auf chess.com. Du hilfst dem Schüler beim Training: Taktikaufgaben, Lektionen, Eröffnungen und Partie-Analysen. Sprich ihn mit "du" an.

Regeln:
- Bewertungen und Varianten kommen AUSSCHLIESSLICH aus den mitgelieferten Daten (Stockfish, Lösungszüge, Theorie-Linien). Erfinde keine Züge und prüfe Aussagen gegen die Stellung (FEN/Diagramm).
- Erkläre die IDEE: Drohungen, Motive (Gabel, Fesselung, Spieß, Abzug, Ablenkung, Überlastung …), Pläne, typische Fehler.
- Niveau des Schülers: ca. {LEVEL} Elo. Klare, kurze Sätze. Deutsch, Züge in SAN mit englischen Figurenbuchstaben (Nf3, Bxe5, O-O).
- Halte dich kurz (meist 2–5 Sätze), außer der Schüler will ausdrücklich eine ausführliche Erklärung oder Lektion.
- Wenn nach einem Hinweis gefragt wird: den Zug nicht verraten, nur die Idee andeuten.
${BEGINNER_RULES}
- Optional darfst du ganz am Ende EINE Zeile "PFEILE: e2e4 g1f3" ausgeben (max. 3, UCI-Format), um Pfeile aufs Brett zu zeichnen.`;

/** Stellungsbeschreibung für den Coach */
export function positionBlock(fen: string, extra: string[] = []) {
  const c = new Chess(fen);
  const s = side(c.turn());
  const state = c.isCheckmate()
    ? L(`Schachmatt – ${s} ist matt gesetzt.`, `Checkmate – ${s} is mated.`)
    : c.isStalemate()
      ? L(`Patt – ${s} hat keinen legalen Zug.`, `Stalemate – ${s} has no legal move.`)
      : L(`${s} ist am Zug${c.inCheck() ? ' und steht im Schach' : ''}.`, `${s} to move${c.inCheck() ? ' and in check' : ''}.`);
  return [L(`Stellung (FEN): ${fen}`, `Position (FEN): ${fen}`), state, L(`Diagramm (Großbuchstaben = Weiß):\n${c.ascii()}`, `Diagram (uppercase = White):\n${c.ascii()}`), ...extra].filter(Boolean).join('\n');
}
