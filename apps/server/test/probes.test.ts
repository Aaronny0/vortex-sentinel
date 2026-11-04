import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as TlsServer } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { loadEnv } from '../src/config/env.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { checkDisk } from '../src/probes/disk.ts';
import { checkHealth } from '../src/probes/health.ts';
import { createProbes } from '../src/probes/runner.ts';
import { checkCertificate } from '../src/probes/tls.ts';
import { createTestDb, type TestDb } from './db.ts';

const clock = manualClock('2026-11-03T14:32:15.000Z');
const valid = (event: EventInput) => expect(eventInputSchema.safeParse(event).success).toBe(true);

/** Un port local sur lequel rien n'écoute : réservé puis libéré. */
const closedPort = () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
};

let http: ReturnType<typeof Bun.serve>;
const url = (path: string) => `http://127.0.0.1:${http.port}${path}`;

beforeAll(() => {
  http = Bun.serve({
    port: 0,
    routes: {
      '/api/v1/health': () => Response.json({ status: 'ok' }),
      '/db-down': () => Response.json({ code: 'DATABASE_UNAVAILABLE', error: 'La base de données est indisponible.' }, { status: 503 }),
      '/html-error': () => new Response('<h1>Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }),
      '/odd-code': () => Response.json({ code: 'contient une adresse a@b.c' }, { status: 500 }),
      '/moved': () => Response.redirect('/api/v1/health', 302),
      '/slow': async () => {
        await Bun.sleep(2_000);
        return Response.json({ status: 'ok' });
      },
    },
  });
});

afterAll(() => {
  http.stop(true);
});

describe('sonde de santé', () => {
  test('réponse 2xx : succès, avec la route, le statut et la cible', async () => {
    const event = await checkHealth({ name: 'vortex-api', url: url('/api/v1/health?x=1') }, { clock });
    valid(event);
    expect(event).toMatchObject({
      source: 'sentinel-probe',
      category: 'availability',
      type: 'probe.check',
      outcome: 'success',
      occurredAt: clock.now().toISOString(),
      http: { method: 'GET', route: '/api/v1/health', status: 200 },
      attributes: { target: 'vortex-api' },
    });
    expect(event.attributes).not.toHaveProperty('code');
  });

  test('erreur de Vortex : échec avec son code', async () => {
    const event = await checkHealth({ name: 'vortex-api', url: url('/db-down') }, { clock });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', http: { status: 503 }, attributes: { code: 'DATABASE_UNAVAILABLE' } });
  });

  test('page d’erreur sans code, ou code douteux : seul le statut est retenu', async () => {
    for (const [path, code] of [['/html-error', 'HTTP_502'], ['/odd-code', 'HTTP_500']] as const) {
      const event = await checkHealth({ name: 'web', url: url(path) }, { clock });
      valid(event);
      expect(event).toMatchObject({ outcome: 'failure', attributes: { code } });
    }
  });

  test('une redirection est un échec : la sonde doit viser l’adresse finale', async () => {
    const event = await checkHealth({ name: 'web', url: url('/moved') }, { clock });
    expect(event).toMatchObject({ outcome: 'failure', http: { status: 302 }, attributes: { code: 'HTTP_302' } });
  });

  test('délai dépassé : échec TIMEOUT, sans statut HTTP', async () => {
    const event = await checkHealth({ name: 'vortex-api', url: url('/slow') }, { clock, timeoutMs: 100 });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { target: 'vortex-api', route: '/slow', code: 'TIMEOUT' } });
    expect(event.http).toBeUndefined();
  });

  test('service injoignable : échec UNREACHABLE', async () => {
    const event = await checkHealth({ name: 'vortex-api', url: `http://127.0.0.1:${closedPort()}/api/v1/health` }, { clock });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { code: 'UNREACHABLE' } });
  });
});

describe('sonde de certificat', () => {
  let dir: string;
  let cert: string;
  let tls: TlsServer;
  let port: number;
  let validTo: Date;

  // Certificat autosigné tiré pour la suite : aucune clé dans le dépôt. Ses dates dépendent du jour réel, donc
  // l'horloge du test est placée par rapport à son expiration, et les résultats ne dépendent pas du jour où l'on teste.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-tls-'));
    const generated = Bun.spawnSync([
      'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '30',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    ]);
    if (generated.exitCode !== 0) throw new Error(`openssl est requis pour ces tests : ${generated.stderr.toString()}`);
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    validTo = new Date(new X509Certificate(cert).validTo);
    tls = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (socket) => socket.end());
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    port = (tls.address() as { port: number }).port;
  });

  afterAll(() => {
    tls?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;
  const at = (daysBeforeExpiry: number) => manualClock(new Date(validTo.getTime() - daysBeforeExpiry * DAY));
  // `localhost` résout vers 127.0.0.1 ici ; le nom sert à vérifier le certificat (SNI et nom attendu).
  const target = () => ({ host: 'localhost', port });

  test('certificat reconnu : succès et jours restants à l’heure de l’horloge', async () => {
    const clockAt = at(16.4);
    const event = await checkCertificate(target(), { clock: clockAt, ca: cert });
    valid(event);
    expect(event).toMatchObject({
      type: 'tls.certificate',
      category: 'availability',
      outcome: 'success',
      attributes: { target: `localhost:${port}`, daysLeft: 16, authorized: true, validTo: validTo.toISOString() },
    });
  });

  test('certificat autosigné non reconnu : échec, mais l’expiration reste mesurée', async () => {
    const event = await checkCertificate(target(), { clock: at(10) });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { daysLeft: 10, authorized: false, code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
  });

  test('certificat expiré à l’heure de l’horloge : échec, jours négatifs', async () => {
    const event = await checkCertificate(target(), { clock: at(-2.5), ca: cert });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { daysLeft: -3, code: 'CERT_HAS_EXPIRED' } });
  });

  test('hôte injoignable : échec avec le code réseau', async () => {
    const event = await checkCertificate({ host: '127.0.0.1', port: closedPort() }, { clock });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { code: 'ECONNREFUSED' } });
    expect(event.attributes).not.toHaveProperty('daysLeft');
  });
});

describe('sonde de disque', () => {
  test('pourcentage libre calculé sur l’espace disponible, pas sur la réserve', async () => {
    const event = await checkDisk('/', { clock, statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 150, bavail: 123 }) });
    valid(event);
    expect(event).toMatchObject({
      type: 'host.disk',
      outcome: 'success',
      attributes: { path: '/', freePercent: 12.3, freeBytes: 123 * 4096, totalBytes: 1000 * 4096 },
    });
  });

  test('mesure réelle d’un système de fichiers', async () => {
    const event = await checkDisk(tmpdir(), { clock });
    valid(event);
    const freePercent = event.attributes!.freePercent as number;
    expect(freePercent).toBeGreaterThanOrEqual(0);
    expect(freePercent).toBeLessThanOrEqual(100);
  });

  test('chemin absent : échec avec le code du système', async () => {
    const event = await checkDisk('/chemin/qui/nexiste/pas', { clock });
    valid(event);
    expect(event).toMatchObject({ outcome: 'failure', attributes: { code: 'ENOENT' } });
  });
});

describe('configuration des sondes', () => {
  const base = { INGEST_DATABASE_URL: 'postgresql://a@b/c', APP_DATABASE_URL: 'postgresql://a@b/c', INGEST_SECRETS: 'a'.repeat(64), OPERATOR_SECRET_KEY: 'b'.repeat(64) };

  test('lit les cibles ; sans configuration, seul le disque racine est surveillé', () => {
    const env = loadEnv({ ...base, PROBE_TARGETS: 'vortex-api=http://127.0.0.1:3001/api/v1/health, web=https://vortex.test/healthz', TLS_TARGETS: 'Vortex.test,admin.vortex.test:8443' });
    expect(env.PROBE_TARGETS).toEqual([
      { name: 'vortex-api', url: 'http://127.0.0.1:3001/api/v1/health' },
      { name: 'web', url: 'https://vortex.test/healthz' },
    ]);
    expect(env.TLS_TARGETS).toEqual([{ host: 'vortex.test', port: 443 }, { host: 'admin.vortex.test', port: 8443 }]);
    expect(loadEnv(base)).toMatchObject({ PROBE_TARGETS: [], TLS_TARGETS: [], DISK_PATHS: ['/'] });
  });

  test('refuse une cible mal formée en nommant la variable', () => {
    for (const [name, value] of [
      ['PROBE_TARGETS', 'http://vortex.test/health'],
      ['PROBE_TARGETS', 'web=ftp://vortex.test/'],
      ['TLS_TARGETS', 'vortex.test:99999'],
      ['TLS_TARGETS', 'https://vortex.test'],
      ['DISK_PATHS', 'var/lib'],
    ] as const) {
      expect(() => loadEnv({ ...base, [name]: value })).toThrow(name);
    }
  });
});

describe('tournées de sondes', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await ensurePartitions(db.appPool, clock);
  });

  afterAll(async () => {
    await db?.drop();
  });

  test('chaque tournée enregistre ses résultats comme des événements', async () => {
    const probes = createProbes({
      ingestPool: db.ingestPool,
      clock,
      config: {
        health: [
          { name: 'vortex-api', url: url('/api/v1/health') },
          { name: 'vortex-web', url: url('/db-down') },
        ],
        tls: [],
        disks: [tmpdir()],
      },
    });
    expect(await probes.health()).toHaveLength(2);
    expect(await probes.disk()).toHaveLength(1);
    expect(await probes.tls()).toHaveLength(0);

    const { rows } = await db.admin.query(
      `SELECT type, outcome, source, http_status, body->'attributes'->>'target' AS target, received_at
       FROM sentinel.event ORDER BY type, target`,
    );
    expect(rows.map(({ received_at, ...row }) => row)).toEqual([
      { type: 'host.disk', outcome: 'success', source: 'sentinel-probe', http_status: null, target: null },
      { type: 'probe.check', outcome: 'success', source: 'sentinel-probe', http_status: 200, target: 'vortex-api' },
      { type: 'probe.check', outcome: 'failure', source: 'sentinel-probe', http_status: 503, target: 'vortex-web' },
    ]);
    expect(rows.every((row) => row.received_at.toISOString() === clock.now().toISOString())).toBe(true);
  });
});
