// Dünner Wrapper um Stockfish (WASM) im Web Worker. Jobs laufen nacheinander.

export interface EngineLine {
  multipv: number;
  depth: number;
  /** Bewertung aus Sicht der Seite am Zug (Centipawns), Matt wird auf ±(100000 - n) abgebildet */
  score: number;
  mate: number | null;
  pv: string[];
}

export interface AnalyzeOptions {
  depth?: number;
  movetime?: number;
  multipv?: number;
  /** Zwischenstände, sobald eine Suchtiefe fertig ist */
  onUpdate?: (lines: EngineLine[]) => void;
}

export const ENGINE_URL = '/engine/stockfish-17.1-lite-single-03e3232.js';

export class Engine {
  private worker: Worker;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private listener: ((line: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e) => this.listener?.(String(e.data));
    this.ready = this.waitFor('uci', 'uciok').then(() => this.waitFor('isready', 'readyok'));
  }

  private waitFor(cmd: string, token: string) {
    return new Promise<void>((resolve) => {
      this.listener = (l) => {
        if (l.startsWith(token)) resolve();
      };
      this.worker.postMessage(cmd);
    });
  }

  analyze(fen: string, opts: AnalyzeOptions = {}): Promise<EngineLine[]> {
    const job = this.queue.then(() => this.ready).then(() => this.run(fen, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  private run(fen: string, { depth = 12, movetime, multipv = 1, onUpdate }: AnalyzeOptions) {
    return new Promise<EngineLine[]>((resolve) => {
      const lines = new Map<number, EngineLine>();
      this.listener = (l) => {
        if (l.startsWith('info') && l.includes(' pv ')) {
          const tok = l.split(' ');
          const get = (k: string) => tok[tok.indexOf(k) + 1];
          const mpv = tok.includes('multipv') ? Number(get('multipv')) : 1;
          const isMate = tok.includes('mate');
          const raw = Number(isMate ? get('mate') : get('cp'));
          if (tok.includes('lowerbound') || tok.includes('upperbound')) return;
          lines.set(mpv, {
            multipv: mpv,
            depth: Number(get('depth')),
            mate: isMate ? raw : null,
            score: isMate ? Math.sign(raw || -1) * (100000 - Math.abs(raw)) : raw,
            pv: tok.slice(tok.indexOf('pv') + 1),
          });
          if (onUpdate && mpv === multipv) onUpdate([...lines.values()].sort((a, b) => a.multipv - b.multipv));
        } else if (l.startsWith('bestmove')) {
          const out = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
          // Matt/Patt: keine Züge – trotzdem auflösen
          resolve(out);
        }
      };
      const w = this.worker;
      w.postMessage(`setoption name MultiPV value ${multipv}`);
      w.postMessage(`position fen ${fen}`);
      // Tiefe als Ziel, Zeitlimit als Notbremse (je nachdem, was zuerst erreicht ist)
      w.postMessage(`go depth ${depth}${movetime ? ` movetime ${movetime}` : ''}`);
    });
  }

  /** Bricht die laufende Suche ab (das Ergebnis bis dahin wird geliefert) */
  stop() {
    this.worker.postMessage('stop');
  }

  destroy() {
    this.worker.terminate();
  }
}

/**
 * Analysiert immer nur die zuletzt gewünschte Stellung: ein neuer Auftrag bricht den alten ab.
 * Ideal für Analysebretter, auf denen schnell durch Züge geklickt wird.
 */
export class LiveAnalyzer {
  private target: { fen: string; opts: AnalyzeOptions } | null = null;
  private running = false;

  constructor(private engine: Engine) {}

  analyze(fen: string, opts: AnalyzeOptions) {
    this.target = { fen, opts };
    if (this.running) this.engine.stop();
    else this.loop();
  }

  private async loop() {
    this.running = true;
    while (this.target) {
      const { fen, opts } = this.target;
      this.target = null;
      const lines = await this.engine.analyze(fen, { ...opts, onUpdate: (l) => !this.target && opts.onUpdate?.(l) });
      if (!this.target) opts.onUpdate?.(lines);
    }
    this.running = false;
  }

  cancel() {
    this.target = null;
    if (this.running) this.engine.stop();
  }
}

/** Bewertung aus Sicht Weiß */
export function whiteScore(fen: string, l: EngineLine) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  return { score: l.score * sign, mate: l.mate !== null ? l.mate * sign : null };
}

/** Gewinnwahrscheinlichkeit (0-100) aus Centipawns – gleiche Kurve wie Lichess. */
export function winPercent(cp: number) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function formatScore(score: number, mate: number | null) {
  // Matt auf dem Brett (keine Züge mehr)
  if (mate === 0) return '#';
  if (mate !== null) return `${mate > 0 ? '' : '-'}M${Math.abs(mate)}`;
  const v = score / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}
