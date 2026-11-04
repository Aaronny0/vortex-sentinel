import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { r18RepeatedErrors } from '../src/rules/r18-repeated-errors.ts';
import { r19AdminNewIp } from '../src/rules/r19-admin-new-ip.ts';
import { r20AdminBurst } from '../src/rules/r20-admin-burst.ts';
import { DAY_MS, MINUTE_MS, type Rule } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

/**
 * R18 (fonctionnalité en panne), R19 et R20 (administration de la plateforme). Ces règles évaluent l'instant
 * « maintenant − 60 s » (délai de grâce) : `before(ms)` place un événement par rapport à cet instant.
 */
const START = '2026-11-04T14:00:00.000Z';
const SECOND = 1000;
const HOUR_MS = 60 * MINUTE_MS;
const clock = manualClock(START);
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  clock.set(START);
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
});

const GRACE = MINUTE_MS;
const before = (ms: number) => new Date(clock.now().getTime() - GRACE - ms);
const hash = (name: string) => createHash('sha256').update(name).digest('hex');
const adminIds: Record<string, string> = {};
const adminId = (who: string) => (adminIds[who] ??= randomUUID());
const organizations = ['21b9a0c8-3d7e-4f61-9a2b-5c4d3e2f1a05', '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c01', '9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0'];

const vortex = (partial: Partial<EventInput> & Pick<EventInput, 'type' | 'category' | 'outcome'>): EventInput =>
  eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: clock.now().toISOString(), source: 'vortex-api', ...partial });
const serverError = (route: string, method: 'GET' | 'POST' = 'POST') =>
  vortex({ type: 'app.error', category: 'technical', outcome: 'failure', http: { method, route, status: 500, durationMs: 40 }, attributes: { code: 'INTERNAL' } });
const effectFailed = (command: string) => vortex({ type: 'command.effect_failed', category: 'technical', outcome: 'failure', attributes: { command } });
const adminLogin = (who: string, ip: string) =>
  vortex({ type: 'auth.login', category: 'security', outcome: 'success', actor: { emailHash: hash(who) }, network: { ip }, attributes: { method: 'otp' } });
const adminAction = (who: string, ip: string, action = 'subscription.resume', organization = organizations[0]) =>
  vortex({
    type: 'admin.action',
    category: 'security',
    outcome: 'success',
    actor: { adminId: adminId(who), emailHash: hash(who) },
    tenant: { organizationId: organization! },
    network: { ip },
    attributes: { action },
  });
const accessDecision = (who: string, ip: string, status: string) =>
  vortex({ type: 'access.status_changed', category: 'security', outcome: 'success', actor: { adminId: adminId(who), emailHash: hash(who) }, network: { ip }, attributes: { status } });

const receive = async (event: EventInput, at: Date) => {
  await storeBatch(db.ingestPool, [event], at);
  return event.id;
};
/** `n` événements espacés de `stepMs`, le dernier reçu à `lastAt`. */
const series = async (n: number, make: (i: number) => EventInput, lastAt: Date, stepMs = 10 * SECOND) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await receive(make(i), new Date(lastAt.getTime() - (n - 1 - i) * stepMs)));
  return ids;
};
const run = (rule: Rule) => runRule(db.appPool, rule, clock);
const alerts = async () =>
  (await db.admin.query('SELECT rule_id, key, severity, summary, evidence::text[] AS evidence, hits FROM sentinel.alert ORDER BY first_seen_at, key')).rows;

describe('R18 : fonctionnalité en panne', () => {
  test('3 erreurs serveur sur une même route en 15 min, sans autre trafic : élevée, preuves dans l’ordre', async () => {
    const ids = await series(3, () => serverError('/api/v1/commands/:type'), before(0), MINUTE_MS);
    expect(await run(r18RepeatedErrors)).toMatchObject({ findings: 1 });
    expect(await alerts()).toEqual([
      expect.objectContaining({ key: 'route POST /api/v1/commands/:type', severity: 'high', summary: '3 erreurs serveur sur POST /api/v1/commands/:type en 15 min', evidence: ids }),
    ]);
  });

  test('2 erreurs, ou 3 réparties sur des routes différentes : rien', async () => {
    await series(2, () => serverError('/api/v1/sales'), before(0));
    await receive(serverError('/api/v1/a'), before(0));
    await receive(serverError('/api/v1/b'), before(0));
    await receive(serverError('/api/v1/c', 'GET'), before(0));
    await receive(serverError('/api/v1/c'), before(0));
    expect(await run(r18RepeatedErrors)).toMatchObject({ findings: 0 });
  });

  test('bord de fenêtre : une erreur de plus de 15 min ne compte plus', async () => {
    await receive(serverError('/api/v1/workspace', 'GET'), before(15 * MINUTE_MS));
    await series(2, () => serverError('/api/v1/workspace', 'GET'), before(0));
    expect(await run(r18RepeatedErrors)).toMatchObject({ findings: 0 });
    clock.advance(SECOND);
    await receive(serverError('/api/v1/workspace', 'GET'), before(0));
    expect(await run(r18RepeatedErrors)).toMatchObject({ findings: 1 });
  });

  test('erreur arrivée en retard : comptée à sa réception, l’alerte reste unique', async () => {
    await series(3, () => serverError('/api/v1/documents'), before(0));
    await run(r18RepeatedErrors);
    clock.advance(30 * SECOND);
    const late = serverError('/api/v1/documents');
    await receive({ ...late, occurredAt: new Date(clock.now().getTime() - 20 * MINUTE_MS).toISOString() }, before(0));
    await run(r18RepeatedErrors);
    const [alert] = await alerts();
    expect(await alerts()).toHaveLength(1);
    expect(alert.evidence).toContain(late.id);
  });

  test('3 effets non exécutés après une même commande : élevée, clé par commande', async () => {
    await series(3, () => effectFailed('team.invite'), before(0));
    await series(2, () => effectFailed('sale.create'), before(0));
    expect(await run(r18RepeatedErrors)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: 'commande team.invite', summary: '3 effets non exécutés après team.invite en 15 min (email ou notification)' });
  });
});

describe('R19 : administration depuis une adresse inhabituelle', () => {
  test('action depuis une IP jamais vue en 30 jours, même si la connexion du jour vient de cette IP : élevée', async () => {
    await receive(adminLogin('admin', '203.0.113.10'), before(3 * DAY_MS));
    await receive(adminAction('admin', '203.0.113.10'), before(3 * DAY_MS - MINUTE_MS));
    await receive(adminLogin('admin', '198.51.100.66'), before(20 * MINUTE_MS));
    const action = await receive(adminAction('admin', '198.51.100.66', 'subscription.suspend'), before(MINUTE_MS));
    expect(await run(r19AdminNewIp)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({
      key: hash('admin'),
      severity: 'high',
      summary: `subscription.suspend par l'administrateur ${hash('admin').slice(0, 8)} depuis une adresse jamais vue en 30 jours (198.51.100.66)`,
      evidence: [action],
    });
  });

  test('décision d’accès depuis une IP inconnue : élevée aussi', async () => {
    await receive(adminAction('admin', '203.0.113.10'), before(2 * DAY_MS));
    await receive(accessDecision('admin', '198.51.100.67', 'APPROVED'), before(0));
    expect(await run(r19AdminNewIp)).toMatchObject({ findings: 1 });
    expect((await alerts())[0].summary).toStartWith("décision d'accès par l'administrateur");
  });

  test('adresse habituelle, administrateur sans historique, ou adresse vue il y a plus de 30 jours seulement : rien', async () => {
    await receive(adminLogin('ama', '203.0.113.10'), before(5 * DAY_MS));
    await receive(adminAction('ama', '203.0.113.10'), before(0));

    await receive(adminLogin('bio', '198.51.100.70'), before(30 * MINUTE_MS));
    await receive(adminAction('bio', '198.51.100.70'), before(0));
    expect(await run(r19AdminNewIp)).toMatchObject({ findings: 0 });

    clock.advance(SECOND);
    await receive(adminLogin('cyr', '203.0.113.30'), before(31 * DAY_MS));
    await receive(adminLogin('cyr', '198.51.100.71'), before(2 * DAY_MS));
    await receive(adminAction('cyr', '203.0.113.30'), before(0));
    expect(await run(r19AdminNewIp)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: hash('cyr') });
  });

  test('bord de la session : une adresse vue 11 h avant n’est pas encore connue, 13 h avant elle l’est', async () => {
    await receive(adminLogin('dan', '203.0.113.40'), before(5 * DAY_MS));
    await receive(adminLogin('dan', '198.51.100.72'), before(13 * HOUR_MS));
    await receive(adminAction('dan', '198.51.100.72'), before(0));
    await receive(adminLogin('eve', '203.0.113.41'), before(5 * DAY_MS));
    await receive(adminLogin('eve', '198.51.100.73'), before(11 * HOUR_MS));
    await receive(adminAction('eve', '198.51.100.73'), before(0));
    expect(await run(r19AdminNewIp)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: hash('eve') });
  });
});

describe('R20 : rafale d’actions d’administration sensibles', () => {
  test('5 actions sensibles en 10 min sur plusieurs entreprises : élevée', async () => {
    const make = (i: number) =>
      i === 4 ? accessDecision('admin', '203.0.113.10', 'SUSPENDED') : adminAction('admin', '203.0.113.10', i % 2 ? 'subscription.payment_cancel' : 'subscription.suspend', organizations[i % 3]);
    const ids = await series(5, make, before(0), MINUTE_MS);
    expect(await run(r20AdminBurst)).toMatchObject({ findings: 1 });
    expect(await alerts()).toEqual([
      expect.objectContaining({ key: hash('admin'), severity: 'high', summary: `5 actions sensibles de l'administrateur ${hash('admin').slice(0, 8)} en 10 min (3 entreprises)`, evidence: ids }),
    ]);
  });

  test('4 actions sensibles, ou des actions ordinaires (paiements, inventaires, accès approuvés) : rien', async () => {
    await series(4, () => adminAction('ama', '203.0.113.10', 'subscription.tariff'), before(0));
    await series(6, (i) => adminAction('bio', '203.0.113.10', i % 2 ? 'subscription.payment' : 'inventory.save'), before(0));
    await series(5, () => accessDecision('cyr', '203.0.113.10', 'APPROVED'), before(0));
    expect(await run(r20AdminBurst)).toMatchObject({ findings: 0 });
  });

  test('bord de fenêtre : une action de plus de 10 min ne compte plus', async () => {
    await receive(adminAction('dan', '203.0.113.10', 'subscription.suspend'), before(10 * MINUTE_MS));
    await series(4, () => adminAction('dan', '203.0.113.10', 'subscription.suspend'), before(0));
    expect(await run(r20AdminBurst)).toMatchObject({ findings: 0 });
  });
});
