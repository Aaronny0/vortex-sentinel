import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { r03SlowRoute } from '../src/rules/r03-slow-route.ts';
import { r04ServerErrors } from '../src/rules/r04-server-errors.ts';
import { r05AccountBruteForce } from '../src/rules/r05-account-brute-force.ts';
import { r06CredentialStuffing } from '../src/rules/r06-credential-stuffing.ts';
import { r07Compromise } from '../src/rules/r07-compromise.ts';
import { r08AccessDenied } from '../src/rules/r08-access-denied.ts';
import { r09NewIpPrivilegeChange } from '../src/rules/r09-new-ip-privilege-change.ts';
import { r14ApiProbing } from '../src/rules/r14-api-probing.ts';
import { r16MailFailures } from '../src/rules/r16-mail-failures.ts';
import { DAY_MS, MINUTE_MS, type Rule } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

/**
 * Règles qui lisent les événements de Vortex. Ces règles évaluent l'instant « maintenant − 60 s » (délai de grâce) :
 * `before(ms)` place un événement par rapport à cet instant.
 */
const START = '2026-11-04T14:00:00.000Z';
const SECOND = 1000;
const clock = manualClock(START);
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  clock.set(START);
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
});

const GRACE = MINUTE_MS;
const before = (ms: number) => new Date(clock.now().getTime() - GRACE - ms);
const hash = (name: string) => createHash('sha256').update(name).digest('hex');
const tenant = { organizationId: '21b9a0c8-3d7e-4f61-9a2b-5c4d3e2f1a05', storeId: '7c6b5a49-3827-4615-a4b3-c2d1e0f9a806' };

const vortex = (partial: Partial<EventInput> & Pick<EventInput, 'type' | 'category' | 'outcome'>): EventInput =>
  eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: clock.now().toISOString(), source: 'vortex-api', ...partial });
const login = (outcome: 'success' | 'failure', who: string, ip = '203.0.113.10') =>
  vortex({ type: 'auth.login', category: 'security', outcome, actor: { emailHash: hash(who) }, network: { ip }, attributes: { method: 'password' } });
const denied = (ip: string, route = '/api/v1/commands') =>
  vortex({ type: 'access.denied', category: 'security', outcome: 'failure', network: { ip }, http: { method: 'POST', route, status: 403, durationMs: 4 } });
const change = (type: 'team.update' | 'settings.save' | 'sale.create', who: string) =>
  vortex({ type, category: 'business', outcome: 'success', actor: { emailHash: hash(who), role: 'owner' }, tenant, business: { operationType: type, reference: 'EQP-2026-000001' } });
const mailFailed = () => vortex({ type: 'mail.failed', category: 'availability', outcome: 'failure', attributes: { kind: 'link' } });
const metrics = (minute: Date, route: string, p95Ms: number, count = 10, serverErrors = 0) =>
  vortex({
    type: 'http.metrics',
    category: 'technical',
    outcome: 'success',
    attributes: { method: 'GET', route, windowStart: minute.toISOString(), windowSeconds: 60, count, serverErrors, clientErrors: 0, p50Ms: 100, p95Ms, maxMs: p95Ms },
  });

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

describe('R05 : force brute sur un compte', () => {
  test('10 refus en 10 min sur un compte : alerte élevée, preuves dans l’ordre', async () => {
    const ids = await series(10, (i) => login('failure', 'awa', `203.0.113.${i % 3}`), before(0), 30 * SECOND);
    expect(await run(r05AccountBruteForce)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: hash('awa'), severity: 'high', summary: `10 connexions refusées sur le compte ${hash('awa').slice(0, 8)} en 10 min (3 adresses IP)`, evidence: ids });
  });

  test('9 refus, ou 10 étalés sur plus de 10 min : rien', async () => {
    await series(9, () => login('failure', 'awa'), before(0));
    expect(await run(r05AccountBruteForce)).toMatchObject({ findings: 0 });
    await receive(login('failure', 'awa'), before(10 * MINUTE_MS));
    clock.advance(SECOND);
    expect(await run(r05AccountBruteForce)).toMatchObject({ findings: 0 });
  });

  test('refus sur des comptes différents : pas de force brute sur un compte', async () => {
    await series(12, (i) => login('failure', `compte-${i}`), before(0));
    expect(await run(r05AccountBruteForce)).toMatchObject({ findings: 0 });
  });

  test('un lot en retard, reçu pendant le délai de grâce, complète la série au cycle suivant', async () => {
    await series(9, () => login('failure', 'awa'), before(0));
    await run(r05AccountBruteForce);
    await receive(login('failure', 'awa'), new Date(clock.now().getTime() - 30 * SECOND));
    clock.advance(30 * SECOND);
    expect(await run(r05AccountBruteForce)).toMatchObject({ findings: 1, opened: 1 });
  });
});

describe('R06 : bourrage d’identifiants', () => {
  test('20 refus depuis une IP sur 5 comptes : alerte sur l’adresse', async () => {
    await series(20, (i) => login('failure', `compte-${i % 5}`, '198.51.100.7'), before(0), 5 * SECOND);
    expect(await run(r06CredentialStuffing)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: '198.51.100.7', summary: '20 connexions refusées depuis 198.51.100.7 sur 5 comptes en 10 min' });
  });

  test('20 refus sur 4 comptes seulement, ou 19 sur 5 : rien', async () => {
    await series(20, (i) => login('failure', `compte-${i % 4}`, '198.51.100.7'), before(0), 5 * SECOND);
    await series(19, (i) => login('failure', `autre-${i % 5}`, '198.51.100.8'), before(0), 5 * SECOND);
    expect(await run(r06CredentialStuffing)).toMatchObject({ findings: 0 });
  });
});

describe('R07 : connexion réussie après une attaque', () => {
  test('force brute puis réussite sur le même compte : critique, la réussite en première preuve', async () => {
    const failures = await series(10, () => login('failure', 'awa', '198.51.100.9'), before(5 * MINUTE_MS), 20 * SECOND);
    const success = await receive(login('success', 'awa', '198.51.100.9'), before(MINUTE_MS));
    expect(await run(r07Compromise)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({
      key: hash('awa'),
      severity: 'critical',
      summary: `Connexion réussie sur le compte ${hash('awa').slice(0, 8)} après 10 refus (force brute)`,
      evidence: [success, ...failures],
    });
  });

  test('bourrage d’identifiants depuis une IP, puis réussite sur un des comptes visés', async () => {
    await series(20, (i) => login('failure', `compte-${i % 5}`, '198.51.100.7'), before(10 * MINUTE_MS), 5 * SECOND);
    await receive(login('success', 'compte-3', '198.51.100.7'), before(MINUTE_MS));
    await run(r07Compromise);
    expect((await alerts()).map((alert) => [alert.key, alert.summary])).toEqual([
      [hash('compte-3'), `Connexion réussie sur le compte ${hash('compte-3').slice(0, 8)} après 4 refus (bourrage d'identifiants depuis 198.51.100.7)`],
    ]);
  });

  test('refus et réussite arrivés dans le même lot : l’ordre vient de l’heure de l’événement', async () => {
    const at = before(MINUTE_MS);
    const failures = Array.from({ length: 12 }, (_, i) => ({ ...login('failure', 'awa', '198.51.100.9'), occurredAt: new Date(at.getTime() - (12 - i) * SECOND).toISOString() }));
    const success = { ...login('success', 'awa', '198.51.100.9'), occurredAt: at.toISOString() };
    await storeBatch(db.ingestPool, [...failures, success], at);
    expect(await run(r07Compromise)).toMatchObject({ findings: 1 });
    // Une réussite survenue avant les refus du même lot n'est pas une compromission.
    await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
    await storeBatch(db.ingestPool, [{ ...success, id: crypto.randomUUID(), occurredAt: new Date(at.getTime() - 60 * SECOND).toISOString() }, ...failures.map((event) => ({ ...event, id: crypto.randomUUID() }))], at);
    expect(await run(r07Compromise)).toMatchObject({ findings: 0 });
  });

  test('quelques refus puis réussite (mot de passe oublié) : rien', async () => {
    await series(3, () => login('failure', 'awa'), before(2 * MINUTE_MS));
    await receive(login('success', 'awa'), before(MINUTE_MS));
    expect(await run(r07Compromise)).toMatchObject({ findings: 0 });
  });

  test('bord de fenêtre : une attaque terminée plus de 30 min avant la réussite ne compte pas', async () => {
    await series(10, () => login('failure', 'awa'), before(32 * MINUTE_MS), 10 * SECOND);
    await receive(login('success', 'awa'), before(MINUTE_MS));
    expect(await run(r07Compromise)).toMatchObject({ findings: 0 });
  });
});

describe('R08 : accès refusés répétés', () => {
  test('5 refus pour une même adresse en 10 min : moyenne ; 4 : rien', async () => {
    await series(5, (i) => denied('203.0.113.50', i % 2 ? '/api/v1/commands' : '/api/v1/admin/companies'), before(0));
    await series(4, () => denied('203.0.113.51'), before(0));
    expect(await run(r08AccessDenied)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: 'adresse 203.0.113.50', severity: 'medium', summary: '5 accès refusés pour adresse 203.0.113.50 en 10 min (2 routes)' });
  });
});

describe('R09 : changement sensible depuis une adresse inhabituelle', () => {
  test('connexion depuis une IP jamais vue, puis changement d’équipe dans l’heure : élevée', async () => {
    await receive(login('success', 'awa', '203.0.113.10'), before(10 * DAY_MS));
    const fresh = await receive(login('success', 'awa', '198.51.100.66'), before(40 * MINUTE_MS));
    const update = await receive(change('team.update', 'awa'), before(MINUTE_MS));
    expect(await run(r09NewIpPrivilegeChange)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({
      key: hash('awa'),
      severity: 'high',
      summary: `team.update par le compte ${hash('awa').slice(0, 8)} moins d'une heure après une connexion depuis une adresse jamais vue (198.51.100.66)`,
      evidence: [fresh, update],
    });
  });

  test('adresse habituelle, opération ordinaire, changement plus d’une heure après, ou compte sans historique : rien', async () => {
    await receive(login('success', 'awa', '203.0.113.10'), before(5 * DAY_MS));
    await receive(login('success', 'awa', '203.0.113.10'), before(10 * MINUTE_MS));
    await receive(change('team.update', 'awa'), before(MINUTE_MS));

    await receive(login('success', 'bio', '203.0.113.20'), before(5 * DAY_MS));
    await receive(login('success', 'bio', '198.51.100.70'), before(10 * MINUTE_MS));
    await receive(change('sale.create', 'bio'), before(MINUTE_MS));

    await receive(login('success', 'cyr', '203.0.113.30'), before(5 * DAY_MS));
    await receive(login('success', 'cyr', '198.51.100.71'), before(62 * MINUTE_MS));
    await receive(change('settings.save', 'cyr'), before(MINUTE_MS));

    await receive(login('success', 'dan', '198.51.100.72'), before(10 * MINUTE_MS));
    await receive(change('settings.save', 'dan'), before(MINUTE_MS));
    expect(await run(r09NewIpPrivilegeChange)).toMatchObject({ findings: 0 });
  });
});

describe('R14 : exploration de l’API', () => {
  const access = (ip: string, status: 400 | 404 | 422) =>
    vortex({
      type: status === 404 ? 'http.access' : 'request.rejected',
      category: 'technical',
      outcome: 'failure',
      network: { ip },
      http: { method: 'GET', route: status === 404 ? '/*' : '/api/v1/commands', status, durationMs: 2 },
    });

  test('30 réponses introuvables ou rejetées pour une adresse en 5 min : moyenne ; 29 : rien', async () => {
    await series(30, (i) => access('198.51.100.40', i % 3 ? 404 : 422), before(0), 5 * SECOND);
    await series(29, () => access('198.51.100.41', 404), before(0), 5 * SECOND);
    expect(await run(r14ApiProbing)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: '198.51.100.40', severity: 'medium', summary: '30 requêtes refusées ou introuvables depuis 198.51.100.40 en 5 min (dont 20 introuvables)' });
  });

  test('bord de fenêtre : une réponse de plus de 5 min ne compte plus', async () => {
    await receive(access('198.51.100.40', 404), before(5 * MINUTE_MS));
    await series(29, () => access('198.51.100.40', 404), before(0), 5 * SECOND);
    expect(await run(r14ApiProbing)).toMatchObject({ findings: 0 });
  });
});

describe('R16 : emails en échec', () => {
  test('3 échecs en 15 min : élevée ; 2 : rien ; un échec trop ancien ne compte pas', async () => {
    await receive(mailFailed(), before(15 * MINUTE_MS));
    await series(2, () => mailFailed(), before(0));
    expect(await run(r16MailFailures)).toMatchObject({ findings: 0 });
    clock.advance(SECOND);
    await receive(mailFailed(), before(0));
    expect(await run(r16MailFailures)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({ key: 'vortex-api', severity: 'high', summary: '3 emails non envoyés en 15 min (link)' });
  });
});

describe('R03 : route lente', () => {
  const minute = (offset: number) => new Date(Date.parse('2026-11-04T13:50:00.000Z') + offset * MINUTE_MS);
  const received = (offset: number) => new Date(minute(offset + 1).getTime() + 5 * SECOND);

  test('p95 au-dessus de 2 s pendant 5 minutes consécutives : moyenne', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await receive(metrics(minute(i + 2), '/api/v1/workspace', 2_400 + i * 100), received(i + 2)));
    await run(r03SlowRoute);
    expect(await alerts()).toEqual([
      expect.objectContaining({ key: 'GET /api/v1/workspace', severity: 'medium', summary: 'GET /api/v1/workspace lente depuis 5 min : p95 entre 2,4 et 2,8 s', evidence: ids }),
    ]);
  });

  test('une minute rapide ou une minute sans trafic rompt la suite', async () => {
    for (const i of [2, 3, 4, 5, 6]) await receive(metrics(minute(i), '/api/v1/fast-once', i === 4 ? 300 : 2_500), received(i));
    for (const i of [1, 2, 4, 5, 6]) await receive(metrics(minute(i), '/api/v1/gap', 2_500), received(i));
    expect(await run(r03SlowRoute)).toMatchObject({ findings: 0 });
  });
});

describe('R04 : taux d’erreurs serveur', () => {
  test('plus de 5 % de 5xx sur 5 min à partir de 20 requêtes : élevée', async () => {
    await receive(metrics(before(4 * MINUTE_MS), '/api/v1/a', 100, 30, 0), before(3 * MINUTE_MS));
    const failing = await receive(metrics(before(2 * MINUTE_MS), '/api/v1/b', 100, 10, 3), before(MINUTE_MS));
    await run(r04ServerErrors);
    expect(await alerts()).toEqual([expect.objectContaining({ key: 'vortex-api', severity: 'high', summary: "7,5 % d'erreurs serveur sur 5 min (3 sur 40 requêtes)", evidence: [failing] })]);
  });

  test('5 % pile, ou moins de 20 requêtes : rien', async () => {
    await receive(metrics(before(2 * MINUTE_MS), '/api/v1/a', 100, 40, 2), before(MINUTE_MS));
    expect(await run(r04ServerErrors)).toMatchObject({ findings: 0 });
    await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key');
    clock.advance(SECOND);
    await receive(metrics(before(2 * MINUTE_MS), '/api/v1/a', 100, 19, 19), before(MINUTE_MS));
    expect(await run(r04ServerErrors)).toMatchObject({ findings: 0 });
  });
});

describe('rejeu', () => {
  test('rejoue une attaque passée : mêmes constats que le moteur, rien d’écrit', async () => {
    const { replay } = await import('../src/engine/replay.ts');
    await series(10, () => login('failure', 'awa', '198.51.100.9'), before(20 * MINUTE_MS), 20 * SECOND);
    await receive(login('success', 'awa', '198.51.100.9'), before(15 * MINUTE_MS));
    const from = new Date(clock.now().getTime() - 40 * MINUTE_MS);
    const findings = await replay(db.appPool, [r05AccountBruteForce, r07Compromise], { from, to: clock.now(), stepSeconds: 60 });
    expect(findings.map((finding) => [finding.ruleId, finding.severity, finding.key])).toEqual([
      ['R05', 'high', hash('awa')],
      ['R07', 'critical', hash('awa')],
    ]);
    expect(findings[0]!.firstAt.getTime()).toBeLessThan(findings[1]!.firstAt.getTime());
    expect(await alerts()).toEqual([]);
    expect(Number((await db.admin.query('SELECT count(*) FROM sentinel.rule_checkpoint')).rows[0].count)).toBe(0);
  });
});
