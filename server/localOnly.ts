// Schutz für den lokalen Server: Er lauscht zwar nur auf 127.0.0.1, aber jede Webseite im Browser
// kann ihn ansprechen. Per DNS-Rebinding (fremde Domain zeigt plötzlich auf 127.0.0.1) könnte sie
// sonst Daten lesen/löschen und den Coach über das ChatGPT-Konto nutzen; per Formular-POST
// (CSRF) z. B. abmelden. Daher: nur lokale Host-Namen, schreibende Anfragen nur von der App selbst.
import type { NextFunction, Request, Response } from 'express';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Ist das ein lokaler Host (mit oder ohne Port), z. B. "localhost:8080" oder "gpt-chess.localhost"? */
export function isLocalHost(host: string | undefined, extra: string[] = []): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK.has(name) || name.endsWith('.localhost') || extra.includes(name);
}

/** Ist der Origin-Header (falls vorhanden) die App selbst? */
export function isLocalOrigin(origin: string | undefined, extra: string[] = []): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.host, extra);
  } catch {
    return false;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Middleware: fremde Host-Namen und fremde Origins bei schreibenden Anfragen abweisen */
export function localOnly(extraHosts: string[] = []) {
  const extra = extraHosts.map((h) => h.toLowerCase());
  return (req: Request, res: Response, next: NextFunction) => {
    const okHost = isLocalHost(req.headers.host, extra);
    const okOrigin = SAFE.has(req.method) || isLocalOrigin(req.headers.origin, extra);
    if (okHost && okOrigin) return next();
    res.status(403).json({ error: 'Forbidden: GPT Chess only accepts requests from the local app' });
  };
}
