import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { authHeaders, importCodex, logout, refresh, startLogin, status } from './auth.ts';
import { isCollection, list, remove, upsert } from './store.ts';
import { langMiddleware, T } from './i18n.ts';
import { localOnly } from './localOnly.ts';

const PORT = Number(process.env.SERVER_PORT ?? 3001);
const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
// Die Modell-Liste hängt von der gemeldeten Client-Version ab.
const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION ?? '0.163.0';

const app = express();
// Alte Adresse (vor der Umbenennung) auf die neue umleiten
app.use((req, res, next) => {
  const host = req.headers.host ?? '';
  if (host.startsWith('gpt-schach.localhost')) return res.redirect(301, `http://${host.replace('gpt-schach', 'gpt-chess')}${req.originalUrl}`);
  next();
});
// Nur Anfragen an lokale Adressen (gegen DNS-Rebinding) und schreibende Anfragen nur von der App (gegen CSRF)
app.use(localOnly([new URL(APP_URL).hostname]));
app.use(express.json({ limit: '5mb' }));
app.use(langMiddleware);

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) => async (req: express.Request, res: express.Response) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e: any) {
    if (!res.headersSent) res.status(e.status ?? 500).json({ error: String(e.message ?? e) });
    else res.end();
  }
};

/** Fetch gegen das Codex-Backend; bei 401 einmal Token erneuern und wiederholen. */
async function codexFetch(url: string, init: RequestInit = {}) {
  let r = await fetch(url, { ...init, headers: { ...(init.headers as any), ...(await authHeaders()) } });
  if (r.status === 401) {
    await refresh();
    r = await fetch(url, { ...init, headers: { ...(init.headers as any), ...(await authHeaders()) } });
  }
  return r;
}

app.get('/api/auth/status', wrap(() => status()));
app.post('/api/auth/login', wrap(async () => ({ url: await startLogin(APP_URL) })));
app.post('/api/auth/import-codex', wrap(() => importCodex()));
app.post('/api/auth/logout', wrap(() => (logout(), status())));

// ---------- Eigener Datenspeicher (Partien, Puzzles, Lernfortschritt) ----------

app.get(
  '/api/store/:col',
  wrap((req) => {
    if (!isCollection(String(req.params.col))) throw Object.assign(new Error(T('Unbekannte Sammlung', 'Unknown collection')), { status: 404 });
    return list(String(req.params.col) as any);
  }),
);
app.put(
  '/api/store/:col/:id',
  wrap((req) => {
    if (!isCollection(String(req.params.col))) throw Object.assign(new Error(T('Unbekannte Sammlung', 'Unknown collection')), { status: 404 });
    return upsert(String(req.params.col) as any, { ...req.body, id: String(req.params.id) });
  }),
);
app.delete(
  '/api/store/:col/:id',
  wrap((req) => {
    if (!isCollection(String(req.params.col))) throw Object.assign(new Error(T('Unbekannte Sammlung', 'Unknown collection')), { status: 404 });
    remove(String(req.params.col) as any, String(req.params.id));
    return { ok: true };
  }),
);

// ---------- Taktikaufgaben über die offene Lichess-Puzzle-API (CC0) ----------

/** Lichess-Puzzle in ein handliches Format bringen: Stellung vor dem ersten Lösungszug */
function normalizePuzzle(j: any) {
  const c = new Chess();
  const sans: string[] = j.game.pgn.split(' ');
  let last: { from: string; to: string } | null = null;
  for (const san of sans) last = c.move(san);
  return {
    id: j.puzzle.id as string,
    rating: j.puzzle.rating as number,
    plays: j.puzzle.plays as number,
    themes: j.puzzle.themes as string[],
    solution: j.puzzle.solution as string[],
    fen: c.fen(),
    lastMove: last ? [last.from, last.to] : null,
    color: c.turn(),
    gameUrl: `https://lichess.org/${j.game.id}`,
  };
}

async function lichess(pathAndQuery: string) {
  const r = await fetch(`https://lichess.org/api${pathAndQuery}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw Object.assign(new Error(`${T('Lichess antwortet mit', 'Lichess responded with')} ${r.status}`), { status: r.status === 429 ? 429 : 502 });
  return r.json();
}

let dailyCache: { day: string; data: unknown } | null = null;
app.get(
  '/api/puzzle/daily',
  wrap(async () => {
    const day = new Date().toISOString().slice(0, 10);
    if (dailyCache?.day !== day) dailyCache = { day, data: { ...normalizePuzzle(await lichess('/puzzle/daily')), day } };
    return dailyCache.data;
  }),
);

app.get(
  '/api/puzzle/next',
  wrap(async (req) => {
    const params = new URLSearchParams();
    const { angle, difficulty } = req.query as Record<string, string>;
    if (angle) params.set('angle', angle);
    if (difficulty) params.set('difficulty', difficulty);
    const seen = new Set(list('puzzles').map((p) => p.id));
    // Bereits gelöste Aufgaben überspringen (ein paar Versuche)
    let p = normalizePuzzle(await lichess(`/puzzle/next?${params}`));
    for (let i = 0; i < 3 && seen.has(p.id); i++) p = normalizePuzzle(await lichess(`/puzzle/next?${params}`));
    return p;
  }),
);

// ---------- Puzzle-Vorrat für Puzzle Rush ----------
// Im Hintergrund nacheinander nachladen (schonend für Lichess), damit im Rush keine Wartezeit entsteht.

const DIFFICULTIES = ['easiest', 'easier', 'normal', 'harder', 'hardest'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const POOL_TARGET = 14;
const pool = new Map<Difficulty, ReturnType<typeof normalizePuzzle>[]>(DIFFICULTIES.map((d) => [d, []]));
const recentlyServed = new Set<string>();
let refilling = false;
let backoffUntil = 0;

async function refillPool(priority: Difficulty[]) {
  if (refilling) return;
  refilling = true;
  try {
    for (let guard = 0; guard < 80; guard++) {
      const d = priority.find((x) => pool.get(x)!.length < POOL_TARGET);
      if (!d) break;
      if (Date.now() < backoffUntil) await new Promise((r) => setTimeout(r, backoffUntil - Date.now()));
      try {
        const p = normalizePuzzle(await lichess(`/puzzle/next?difficulty=${d}`));
        const list = pool.get(d)!;
        if (!recentlyServed.has(p.id) && !list.some((x) => x.id === p.id)) list.push(p);
      } catch (e: any) {
        backoffUntil = Date.now() + (e.status === 429 ? 60_000 : 3_000);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    refilling = false;
  }
}

app.get(
  '/api/puzzle/pool',
  wrap(async (req) => {
    const d = (DIFFICULTIES as readonly string[]).includes(String(req.query.difficulty)) ? (String(req.query.difficulty) as Difficulty) : 'easiest';
    const n = Math.min(5, Math.max(1, Number(req.query.n) || 1));
    const order = [d, ...DIFFICULTIES.filter((x) => x !== d)];
    refillPool(order);
    // Kurz warten, falls der Vorrat für diese Stufe gerade leer ist
    for (let i = 0; i < 40 && !pool.get(d)!.length; i++) await new Promise((r) => setTimeout(r, 150));
    const list = pool.get(d)!;
    const out = list.splice(0, n);
    if (!out.length) out.push(normalizePuzzle(await lichess(`/puzzle/next?difficulty=${d}`)));
    out.forEach((p) => recentlyServed.add(p.id));
    refillPool(order);
    return out;
  }),
);

let modelCache: { at: number; data: unknown } | null = null;
app.get(
  '/api/models',
  wrap(async () => {
    if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.data;
    const r = await codexFetch(`${CODEX_BASE}/models?client_version=${CLIENT_VERSION}`);
    if (!r.ok) throw Object.assign(new Error(`${T('Modelle konnten nicht geladen werden', 'Could not load models')} (${r.status})`), { status: r.status });
    const j: any = await r.json();
    const models = (j.models ?? [])
      .filter((m: any) => m.visibility !== 'hide')
      .map((m: any) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        description: m.description ?? '',
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort),
        defaultEffort: m.default_reasoning_level ?? 'medium',
      }));
    modelCache = { at: Date.now(), data: { models } };
    return modelCache.data;
  }),
);

/**
 * Coach-Anfrage: leitet an die Responses-API des Codex-Backends weiter
 * und streamt nur die Text-Deltas als SSE an den Browser.
 */
app.post(
  '/api/coach',
  wrap(async (req, res) => {
    const { model, effort, instructions, messages } = req.body as {
      model: string;
      effort?: string;
      instructions: string;
      messages: { role: 'user' | 'assistant'; content: string }[];
    };
    const upstream = await codexFetch(`${CODEX_BASE}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        instructions,
        input: messages.map((m) => ({
          type: 'message',
          role: m.role,
          content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
        })),
        reasoning: effort ? { effort } : undefined,
        stream: true,
        store: false,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.detail ?? j.error?.message ?? text;
      } catch {}
      throw Object.assign(new Error(msg || `${T('Fehler', 'Error')} ${upstream.status}`), { status: upstream.status });
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const decoder = new TextDecoder();
    let buf = '';
    let aborted = false;
    res.on('close', () => (aborted = true));
    const reader = upstream.body.getReader();
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'response.output_text.delta') send({ t: 'delta', d: ev.delta });
          else if (ev.type === 'response.failed' || ev.type === 'error')
            send({ t: 'error', d: ev.response?.error?.message ?? ev.message ?? 'Unbekannter Fehler' });
        } catch {}
      }
    }
    if (aborted) reader.cancel().catch(() => {});
    send({ t: 'done' });
    res.end();
  }),
);

// Produktions-Build ausliefern
const dist = path.resolve(import.meta.dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Nur lokal erreichbar – IPv4 und IPv6, damit *.localhost-Adressen im Browser direkt funktionieren
app.listen(PORT, '127.0.0.1', () => console.log(`GPT Chess Server läuft auf ${APP_URL}`));
app.listen(PORT, '::1').on('error', () => {});
