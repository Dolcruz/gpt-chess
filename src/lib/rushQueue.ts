import type { PuzzleData } from './usePuzzle';

/** Der Rush-Vorrat teilt eine laufende Anfrage mit dem wartenden Brett. */
export class RushQueue {
  private puzzles: PuzzleData[] = [];
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private version = 0;

  constructor(private fetchBatch: (difficulty: string, signal: AbortSignal) => Promise<PuzzleData[]>) {}

  get size() {
    return this.puzzles.length;
  }

  refill(difficulty: string): Promise<void> {
    if (this.pending) return this.pending;
    if (this.puzzles.length >= 3) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    const pending = this.fetchBatch(difficulty, controller.signal).then((batch) => {
      if (controller.signal.aborted) return;
      const seen = new Set(this.puzzles.map((p) => p.id));
      for (const p of batch) {
        if (!seen.has(p.id)) {
          this.puzzles.push(p);
          seen.add(p.id);
        }
      }
    }).finally(() => {
      if (this.controller === controller) {
        this.pending = null;
        this.controller = null;
      }
    });
    this.pending = pending;
    return pending;
  }

  async take(difficulty: string): Promise<PuzzleData | null> {
    const version = this.version;
    if (!this.puzzles.length) await this.refill(difficulty);
    if (version !== this.version) return null;
    return this.puzzles.shift() ?? null;
  }

  reset() {
    this.version++;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.puzzles = [];
  }
}
