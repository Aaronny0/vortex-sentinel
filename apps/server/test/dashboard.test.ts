import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema } from '@sentinel/schema';
import { createApp } from '../src/app.ts';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { createOperatorService, LOGIN_LIMIT } from '../src/operators/service.ts';
import { totpCode, totpStep } from '../src/operators/totp.ts';
import { r06CredentialStuffing } from '../src/rules/r06-credential-stuffing.ts';
import { createTestDb, type TestDb } from './db.ts';

const ORIGIN = 'http://sentinel.test';
const clock = manualClock('2026-11-04T14:00:00.000Z');
const secretKey = Buffer.alloc(32, 9);
let db: TestDb;
let app: ReturnType<typeof createApp>;
const password = 'un-mot-de-passe-solide';
const secrets = new Map<string, string>();

type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null };
const call = async (path: string, init: Init = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  if (init.cookie) headers.set('cookie', init.cookie);
  const response = await app.handle(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
};

/** Connexion complète : mot de passe, puis code (activation au premier passage). Renvoie le cookie de session. */
const login = async (email: string) => {
  clock.advance(31_000); // un nouveau pas de temps : chaque connexion a son propre code
  const first = await call('/api/session/login', { body: { email, password } });
  expect(first.status).toBe(200);
  if (first.body.step === 'enroll') secrets.set(email, first.body.enrollment.secret);
  const code = totpCode(secrets.get(email)!, totpStep(clock.now()));
  const second = await call('/api/session/verify', { body: { challenge: first.body.challenge, code } });
  expect(second.status).toBe(200);
  return second.setCookie!.split(';')[0]!;
};

let admin: string;
let analyst: string;
let observer: string;
let analystId: string;

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
  app = createApp({ ingestPool: db.ingestPool, appPool: db.appPool, clock, secrets: ['c'.repeat(64)], operatorSecretKey: secretKey, dashboardOrigin: ORIGIN });
  const operators = createOperatorService({ pool: db.appPool, clock, secretKey });
  await operators.createOperator({ email: 'admin@sentinel.test', name: 'Admin', role: 'admin', password }, null);
  analystId = (await operators.createOperator({ email: 'analyste@sentinel.test', name: 'Analyste', role: 'analyst', password }, null)).id;
  await operators.createOperator({ email: 'observateur@sentinel.test', name: 'Observateur', role: 'observer', password }, null);
  admin = await login('admin@sentinel.test');
  analyst = await login('analyste@sentinel.test');
  observer = await login('observateur@sentinel.test');

  // Un incident de sécurité réel : bourrage d'identifiants depuis 198.51.100.7 (R06).
  const hash = (name: string) => createHash('sha256').update(name).digest('hex');
  const at = new Date(clock.now().getTime() - 2 * 60_000);
  const events = Array.from({ length: 20 }, (_, i) =>
    eventInputSchema.parse({
      id: randomUUID(), schemaVersion: 1, occurredAt: at.toISOString(), source: 'vortex-api', category: 'security', type: 'auth.login',
      outcome: 'failure', actor: { emailHash: hash(`compte-${i % 5}`) }, network: { ip: '198.51.100.7' },
    }),
  );
  await storeBatch(db.ingestPool, events, at);
  await runRule(db.appPool, r06CredentialStuffing, clock);
});
afterAll(async () => db?.drop());

describe('connexion des opérateurs', () => {
  test('première connexion : activation du code ; cookie httpOnly, SameSite=Strict', async () => {
    const operators = createOperatorService({ pool: db.appPool, clock, secretKey });
    await operators.createOperator({ email: 'nouveau@sentinel.test', name: 'Nouveau', role: 'analyst', password }, null);
    clock.advance(31_000);
    const first = await call('/api/session/login', { body: { email: 'nouveau@sentinel.test', password } });
    // Copie avant toMatchObject : avec des correspondances asymétriques, Bun remplace les valeurs de l'objet vérifié.
    const secret = String(first.body.enrollment.secret);
    expect(structuredClone(first.body)).toMatchObject({ step: 'enroll', enrollment: { secret: expect.stringMatching(/^[A-Z2-7]{32}$/), uri: expect.stringMatching(/^otpauth:\/\/totp\//) } });
    const code = totpCode(secret, totpStep(clock.now()));
    const second = await call('/api/session/verify', { body: { challenge: first.body.challenge, code } });
    expect(second.body.operator).toMatchObject({ email: 'nouveau@sentinel.test', role: 'analyst', totpEnabled: true });
    expect(second.setCookie).toMatch(/^sentinel_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    const stored = await db.admin.query("SELECT totp_secret FROM sentinel.operator WHERE email = 'nouveau@sentinel.test'");
    expect(stored.rows[0].totp_secret).toStartWith('v1.');
    expect(stored.rows[0].totp_secret).not.toContain(secret);
  });

  test('compte activé : le code est demandé, un code déjà utilisé est refusé', async () => {
    clock.advance(31_000);
    const first = await call('/api/session/login', { body: { email: 'analyste@sentinel.test', password } });
    expect(first.body).toEqual({ step: 'totp', challenge: expect.any(String) });
    const code = totpCode(secrets.get('analyste@sentinel.test')!, totpStep(clock.now()));
    expect((await call('/api/session/verify', { body: { challenge: first.body.challenge, code } })).status).toBe(200);
    const again = await call('/api/session/login', { body: { email: 'analyste@sentinel.test', password } });
    expect(await call('/api/session/verify', { body: { challenge: again.body.challenge, code } })).toMatchObject({ status: 401, body: { code: 'INVALID_CODE' } });
  });

  test('mauvais mot de passe et compte inconnu : même réponse ; trop d’essais : 429', async () => {
    const wrong = await call('/api/session/login', { body: { email: 'admin@sentinel.test', password: 'mauvais-mot-de-passe' } });
    const unknown = await call('/api/session/login', { body: { email: 'personne@sentinel.test', password } });
    expect(wrong).toMatchObject({ status: 401, body: { code: 'INVALID_CREDENTIALS', error: 'Adresse ou mot de passe incorrect.' } });
    expect(unknown.body).toEqual(wrong.body);
    for (let i = 0; i < LOGIN_LIMIT.failures; i += 1) await call('/api/session/login', { body: { email: 'cible@sentinel.test', password: 'x' } });
    expect((await call('/api/session/login', { body: { email: 'cible@sentinel.test', password } })).status).toBe(429);
  });

  test('écriture sans la bonne origine : refusée', async () => {
    expect((await call('/api/session/login', { body: { email: 'admin@sentinel.test', password }, origin: 'https://attaquant.example' })).status).toBe(403);
    expect((await call('/api/session/login', { body: { email: 'admin@sentinel.test', password }, origin: null })).status).toBe(403);
  });

  test('sans session : 401 ; déconnexion : la session ne sert plus', async () => {
    expect((await call('/api/overview')).status).toBe(401);
    const cookie = await login('admin@sentinel.test');
    expect((await call('/api/session', { cookie })).body.operator.role).toBe('admin');
    expect((await call('/api/session/logout', { body: {}, cookie })).status).toBe(204);
    expect((await call('/api/session', { cookie })).status).toBe(401);
  });
});

describe('droits par rôle', () => {
  test('Observateur : état et incidents, textes expurgés ; ni alertes, ni événements, ni transitions', async () => {
    expect((await call('/api/overview', { cookie: observer })).status).toBe(200);
    const incidents = await call('/api/incidents', { cookie: observer });
    expect(incidents.body[0].title).toBe('R06 · 20 connexions refusées depuis ••• sur 5 comptes en 10 min');
    const detail = await call(`/api/incidents/${incidents.body[0].id}`, { cookie: observer });
    expect(JSON.stringify(detail.body)).not.toContain('198.51.100.7');
    expect(detail.body.key).toBeUndefined();
    for (const path of ['/api/alerts', '/api/events', '/api/operators'])
      expect((await call(path, { cookie: observer })).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call(`/api/incidents/${incidents.body[0].id}/transitions`, { cookie: observer, body: { to: 'acknowledged' } })).status).toBe(403);
  });

  test('Analyste : preuves et recherche (journalisées), prise en charge ; pas de gestion des opérateurs', async () => {
    const [incident] = (await call('/api/incidents', { cookie: analyst })).body;
    expect(incident).toMatchObject({ reference: expect.stringMatching(/^INC-\d{6}$/), title: expect.stringContaining('198.51.100.7'), severity: 'high' });
    const detail = (await call(`/api/incidents/${incident.id}`, { cookie: analyst })).body;
    const alert = (await call(`/api/alerts/${detail.alerts[0].id}`, { cookie: analyst })).body;
    expect(alert.events).toHaveLength(20);
    expect(alert.events[0]).toMatchObject({ ip: '198.51.100.7', type: 'auth.login' });
    expect((await call('/api/events?ip=198.51.100.7&limit=5', { cookie: analyst })).body.events).toHaveLength(5);
    const taken = await call(`/api/incidents/${incident.id}/transitions`, { cookie: analyst, body: { to: 'acknowledged' } });
    expect(taken.body).toMatchObject({ status: 'acknowledged', assignee_id: analystId });
    expect((await call(`/api/incidents/${incident.id}/comments`, { cookie: analyst, body: { comment: 'Adresse signalée au fournisseur.' } })).status).toBe(201);
    expect((await call('/api/operators', { cookie: analyst })).status).toBe(403);

    const audit = (await call('/api/audit?limit=100', { cookie: admin })).body.map((entry: { action: string }) => entry.action);
    expect(audit).toEqual(expect.arrayContaining(['event.viewed', 'event.searched', 'incident.transition', 'incident.commented', 'session.login', 'session.login_failed']));
  });

  test('Administrateur : il reste toujours un administrateur actif ; désactiver ferme les sessions', async () => {
    const list = (await call('/api/operators', { cookie: admin })).body as { id: string; role: string; email: string }[];
    const self = list.find((operator) => operator.email === 'admin@sentinel.test')!;
    expect((await call(`/api/operators/${self.id}`, { method: 'PATCH', cookie: admin, body: { role: 'analyst' } })).body).toMatchObject({ code: 'LAST_ADMIN' });
    const target = list.find((operator) => operator.email === 'observateur@sentinel.test')!;
    expect((await call(`/api/operators/${target.id}`, { method: 'PATCH', cookie: admin, body: { disabled: true } })).status).toBe(200);
    expect((await call('/api/overview', { cookie: observer })).status).toBe(401);
    expect((await call('/api/operators', { cookie: admin, body: { email: 'x@sentinel.test', name: 'X', role: 'analyst', password: 'court' } })).body).toMatchObject({ code: 'VALIDATION_FAILED', fields: { password: expect.any(String) } });
  });
});

describe('interface servie par Sentinel', () => {
  test('page et fichiers avec en-têtes de sécurité ; routes du navigateur vers index.html ; jamais hors du dossier', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dist = mkdtempSync(join(tmpdir(), 'sentinel-web-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Sentinel</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"Vortex Sentinel"}');
    writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => undefined)');
    const web = createApp({ ingestPool: db.ingestPool, appPool: db.appPool, clock, secrets: ['c'.repeat(64)], operatorSecretKey: secretKey, dashboardOrigin: ORIGIN, webDist: dist });
    const get = (path: string) => web.handle(new Request(`${ORIGIN}${path}`));
    const page = await get('/incidents/123');
    expect(await page.text()).toContain('<title>Sentinel</title>');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const asset = await get('/assets/app.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    // Application installable : manifeste reconnu ; service worker jamais figé en cache, pour que ses mises à jour passent.
    expect((await get('/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json');
    const worker = await get('/sw.js');
    expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(worker.headers.get('cache-control')).toBe('no-cache');
    expect(await (await get('/assets/../../../../etc/passwd')).text()).toContain('<title>Sentinel</title>');
    expect(await (await get('/%2e%2e/%2e%2e/etc/passwd')).text()).toContain('<title>Sentinel</title>');
    expect((await get('/api/inconnu')).status).toBe(404);
    expect((await get('/health')).status).toBe(200);
  });
});

describe('disponibilité', () => {
  test('taux, tranches régulières et interruptions par cible', async () => {
    const base = clock.now().getTime() - 3 * 60 * 60_000;
    const probe = (outcome: 'success' | 'failure', minutes: number) =>
      storeBatch(
        db.ingestPool,
        [eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: new Date(base).toISOString(), source: 'sentinel-probe', category: 'availability', type: 'probe.check', outcome, attributes: { target: 'vortex-api', ...(outcome === 'failure' && { code: 'TIMEOUT' }) }, ...(outcome === 'success' && { http: { method: 'GET', route: '/api/v1/health', status: 200, durationMs: 40 } }) })],
        new Date(base + minutes * 60_000),
      );
    for (const [outcome, minutes] of [['success', 0], ['failure', 1], ['failure', 2], ['failure', 3], ['success', 4], ['success', 5], ['failure', 6], ['success', 7]] as const) await probe(outcome, minutes);
    const result = (await call('/api/availability?days=1', { cookie: analyst })).body;
    const target = result.targets.find((item: { target: string }) => item.target === 'vortex-api');
    expect(target).toMatchObject({ checks: 8, failures: 4, availabilityPercent: 50, p95Ms: 40 });
    expect(target.buckets).toHaveLength(24);
    expect(result.outages.map((outage: { failures: number; code: string }) => [outage.failures, outage.code])).toEqual([[1, 'TIMEOUT'], [3, 'TIMEOUT']]);
    expect((await call('/api/availability?days=3', { cookie: analyst })).status).toBe(422);
  });
});

describe('lectures du tableau de bord', () => {
  test('vue d’ensemble, règles et incidents filtrés', async () => {
    const overview = (await call('/api/overview', { cookie: analyst })).body;
    expect(overview).toMatchObject({ activeIncidents: { high: 1 }, openAlerts: { high: 1 }, eventsLast24h: { security: 20 } });
    const rules = (await call('/api/rules', { cookie: analyst })).body as { id: string; alerts: number }[];
    expect(rules.map((rule) => rule.id)).toContain('R07');
    expect(rules.find((rule) => rule.id === 'R06')).toMatchObject({ alerts: 1, openAlerts: 1, falsePositives: 0 });
    expect((await call('/api/incidents?status=closed', { cookie: analyst })).body).toEqual([]);
    expect((await call('/api/incidents?status=all&severity=critical', { cookie: analyst })).body).toEqual([]);
    expect((await call('/api/incidents?status=all&severity=high', { cookie: analyst })).body).toHaveLength(1);
    expect((await call('/api/incidents?status=inconnu', { cookie: analyst })).status).toBe(422);
    expect((await call('/api/events?from=2026-01-01T00:00:00Z', { cookie: analyst })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  test('évolution des erreurs : 24 tranches d’une heure, serveur et interface, rien au-delà de 24 h', async () => {
    const now = clock.now().getTime();
    const error = (type: 'app.error' | 'ui.error', hoursAgo: number) =>
      storeBatch(
        db.ingestPool,
        [
          eventInputSchema.parse({
            id: randomUUID(), schemaVersion: 1, occurredAt: new Date(now).toISOString(), source: type === 'ui.error' ? 'vortex-web' : 'vortex-api', category: 'technical', type, outcome: 'failure',
            ...(type === 'app.error' ? { http: { method: 'POST', route: '/api/v1/commands/:type', status: 500, durationMs: 12 } } : { attributes: { digest: 'abc123' } }),
          }),
        ],
        new Date(now - hoursAgo * 60 * 60_000),
      );
    for (const hoursAgo of [0.5, 0.25, 2.5, 30]) await error('app.error', hoursAgo);
    await error('ui.error', 0.5);
    const { errorsLast24h } = (await call('/api/overview', { cookie: analyst })).body as { errorsLast24h: { start: string; end: string; server: number; interface: number }[] };
    expect(errorsLast24h).toHaveLength(24);
    expect(errorsLast24h[23]).toEqual({ start: new Date(now - 60 * 60_000).toISOString(), end: new Date(now).toISOString(), server: 2, interface: 1 });
    expect(errorsLast24h[21]).toMatchObject({ server: 1, interface: 0 });
    expect(errorsLast24h.reduce((total, bucket) => total + bucket.server, 0)).toBe(3);
  });
});
