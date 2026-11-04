import { Elysia } from 'elysia';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * En-têtes de toutes les pages du tableau de bord : aucune ressource extérieure (polices et scripts servis par Sentinel),
 * aucun cadre, aucun référent transmis.
 */
export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
} as const;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Sert l'interface construite (`apps/web/dist`) : fichiers connus, et `index.html` pour toute autre adresse (routes du
 * navigateur). `/api`, `/ingest` et `/health` restent à l'API. Le chemin demandé ne sort jamais du dossier.
 */
export function staticPlugin(directory: string) {
  const root = resolve(directory);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return new Elysia({ name: 'static-off' });
  const file = (path: string, cache: string) =>
    new Response(Bun.file(path), { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': cache, ...SECURITY_HEADERS } });
  return new Elysia({ name: 'static' }).get('/*', ({ path }) => {
    if (path.startsWith('/api/') || path === '/ingest' || path === '/health') return new Response(JSON.stringify({ code: 'NOT_FOUND', error: 'Ressource introuvable.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const target = normalize(join(root, decodeURIComponent(path)));
    if (target.startsWith(root + '/') && existsSync(target) && statSync(target).isFile())
      return file(target, target.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return file(index, 'no-cache');
  });
}
