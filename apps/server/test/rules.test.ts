import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runEngineCycle, runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { r01ProbeDown } from '../src/rules/r01-probe-down.ts';
import { r02HeartbeatLost } from '../src/rules/r02-heartbeat-lost.ts';
import { r15CertificateExpiry } from '../src/rules/r15-certificate-expiry.ts';
import { r17DiskSpace } from '../src/rules/r17-disk-space.ts';
import { DAY_MS, MINUTE_MS, type Rule } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

const START = '2026-11-03T14:32:15.000Z';
const SECOND = 1000;
const clock = manualClock(START);
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  clock.set(START);
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

/** Événement conforme au schéma partagé, comme en produisent les sondes et l'émetteur. */
const build = (partial: Pick<EventInput, 'type' | 'category' | 'outcome' | 'source'> & Partial<EventInput>): EventInput =>
  eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: clock.now().toISOString(), ...partial });

const probe = (outcome: 'success' | 'failure', target = 'vortex-api', code?: string) =>
  build({ source: 'sentinel-probe', category: 'availability', type: 'probe.check', outcome, attributes: { target, ...(code && { code }) } });
const heartbeat = (source: 'vortex-api' | 'vortex-web' = 'vortex-api') =>
  build({ source, category: 'availability', type: 'emitter.heartbeat', outcome: 'success' });
const certificate = (validTo: Date | null, target = 'vortex.test:443') =>
  build({
    source: 'sentinel-probe',
    category: 'availability',
    type: 'tls.certificate',
    outcome: validTo ? 'success' : 'failure',
    attributes: validTo ? { target, validTo: validTo.toISOString(), daysLeft: 0, authorized: true } : { target, code: 'ECONNREFUSED' },
  });
const disk = (freePercent: number, path = '/', outcome: 'success' | 'failure' = 'success') =>
  build({ source: 'sentinel-probe', category: 'availability', type: 'host.disk', outcome, attributes: outcome === 'success' ? { path, freePercent } : { path, code: 'ENOENT' } });

/** Enregistre un événement comme reçu à l'instant donné (l'heure de réception fait foi pour les règles). */
const receive = async (event: EventInput, receivedAt: Date) => {
  await storeBatch(db.ingestPool, [event], receivedAt);
  return event.id;
};

const alerts = async () =>
  (
    await db.admin.query(
      `SELECT rule_id, rule_version, key, severity, status, summary, evidence::text[] AS evidence, hits, thresholds,
              first_seen_at, last_seen_at, closed_at
       FROM sentinel.alert ORDER BY first_seen_at, key`,
    )
  ).rows;

const run = (rule: Rule) => runRule(db.appPool, rule, clock);

describe('R01 : service indisponible', () => {
  const failures = async (count: number, startMs = count * 30 * SECOND, target = 'vortex-api') => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await receive(probe('failure', target, 'DATABASE_UNAVAILABLE'), ago(startMs - i * 30 * SECOND)));
    return ids;
  };

  test('3 échecs consécutifs ouvrent une alerte critique, avec les 3 preuves dans l’ordre', async () => {
    await receive(probe('success'), ago(120 * SECOND));
    const ids = await failures(3);
    expect(await run(r01ProbeDown)).toMatchObject({ status: 'evaluated', findings: 1, opened: 1 });
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      rule_id: 'R01',
      rule_version: 1,
      key: 'vortex-api',
      severity: 'critical',
      status: 'open',
      hits: 1,
      summary: '3 échecs consécutifs de la sonde vortex-api (dernier : DATABASE_UNAVAILABLE)',
      evidence: ids,
      thresholds: { consecutiveFailures: 3, lookbackSeconds: 600 },
    });
  });

  test('2 échecs, ou 2 échecs suivis d’un succès : aucune alerte', async () => {
    await failures(2);
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 0 });
    clock.advance(30 * SECOND);
    await receive(probe('failure'), ago(10 * SECOND));
    await receive(probe('success'), ago(0));
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 0 });
    expect(await alerts()).toHaveLength(0);
  });

  test('bord de fenêtre : un échec plus vieux que 10 min ne compte plus', async () => {
    await receive(probe('failure'), ago(10 * MINUTE_MS));
    await receive(probe('failure'), ago(60 * SECOND));
    await receive(probe('failure'), ago(30 * SECOND));
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 0 });
    clock.advance(SECOND);
    await receive(probe('failure'), ago(0));
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 1 });
  });

  test('un échec arrivé après l’évaluation est pris au cycle suivant', async () => {
    await failures(2);
    await run(r01ProbeDown);
    clock.advance(30 * SECOND);
    await receive(probe('failure'), clock.now());
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 1, opened: 1 });
  });

  test('une panne qui dure garde une seule alerte, qui accumule ses preuves', async () => {
    const first = await failures(3);
    await run(r01ProbeDown);
    clock.advance(30 * SECOND);
    const next = await receive(probe('failure'), clock.now());
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 1, opened: 0 });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hits: 2, evidence: [...first, next] });
  });

  test('le service rétabli, l’alerte se clôt après la période de calme ; une nouvelle panne en ouvre une autre', async () => {
    await failures(3);
    await run(r01ProbeDown);
    clock.advance(30 * SECOND);
    await receive(probe('success'), clock.now());
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 0, closed: 0 });
    clock.advance(2 * MINUTE_MS);
    expect(await run(r01ProbeDown)).toMatchObject({ closed: 1 });

    clock.advance(10 * MINUTE_MS);
    await failures(3);
    expect(await run(r01ProbeDown)).toMatchObject({ opened: 1 });
    expect((await alerts()).map((alert) => alert.status)).toEqual(['closed', 'open']);
  });

  test('une alerte par cible', async () => {
    await failures(3, 90 * SECOND, 'vortex-api');
    await failures(3, 90 * SECOND, 'vortex-web');
    expect(await run(r01ProbeDown)).toMatchObject({ findings: 2, opened: 2 });
  });
});

describe('R02 : collecte interrompue', () => {
  // R02 évalue l'instant « maintenant − 60 s » : les durées sont exprimées par rapport à cet instant.
  const beforeEvaluated = (ms: number) => ago(r02HeartbeatLost.graceMs + ms);

  test('battement vieux de plus de 2 min alors que la sonde répond : alerte élevée', async () => {
    const beat = await receive(heartbeat(), beforeEvaluated(3 * MINUTE_MS));
    const ok = await receive(probe('success'), beforeEvaluated(20 * SECOND));
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 1 });
    expect((await alerts())[0]).toMatchObject({
      key: 'vortex-api',
      severity: 'high',
      summary: 'Aucun battement de cœur de vortex-api depuis 3 min alors que la sonde répond',
      evidence: [beat, ok],
    });
  });

  test('bord de fenêtre : 2 min pile déclenche, 1 min 59 s non', async () => {
    await receive(heartbeat(), beforeEvaluated(2 * MINUTE_MS - SECOND));
    await receive(probe('success'), beforeEvaluated(10 * SECOND));
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 0 });
    clock.advance(SECOND);
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 1 });
  });

  test('un battement en retard, arrivé dans le délai de grâce, est pris en compte', async () => {
    await receive(heartbeat(), beforeEvaluated(3 * MINUTE_MS));
    await receive(probe('success'), beforeEvaluated(10 * SECOND));
    // Lot en retard : reçu avant l'instant évalué, mais pendant le délai de grâce du cycle précédent.
    await receive(heartbeat(), beforeEvaluated(30 * SECOND));
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 0 });
  });

  test('émetteur jamais entendu (pas encore déployé) : rien', async () => {
    await receive(probe('success'), beforeEvaluated(10 * SECOND));
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 0 });
  });

  test('sonde en échec : c’est une panne (R01), pas une collecte interrompue', async () => {
    await receive(heartbeat(), beforeEvaluated(5 * MINUTE_MS));
    await receive(probe('failure'), beforeEvaluated(10 * SECOND));
    expect(await run(r02HeartbeatLost)).toMatchObject({ findings: 0 });
  });
});

describe('R15 : certificat bientôt expiré', () => {
  const inDays = (days: number) => new Date(clock.now().getTime() + days * DAY_MS);

  test('gravité selon les jours restants, à l’instant évalué', async () => {
    const cases: [number, string | null, string][] = [
      [20, null, ''],
      [14, null, ''],
      [13.9, 'medium', 'Le certificat de vortex.test:443 expire dans 13 jours (2026-11-17)'],
      [3, 'medium', 'Le certificat de vortex.test:443 expire dans 3 jours (2026-11-06)'],
      [2.5, 'critical', 'Le certificat de vortex.test:443 expire dans 2 jours (2026-11-06)'],
      [-1, 'critical', 'Le certificat de vortex.test:443 a expiré le 2026-11-02'],
    ];
    for (const [days, severity, summary] of cases) {
      await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
      await receive(certificate(inDays(days)), ago(MINUTE_MS));
      await run(r15CertificateExpiry);
      const rows = await alerts();
      expect(rows.map((row) => [row.severity, row.summary])).toEqual(severity ? [[severity, summary]] : []);
    }
  });

  test('la mesure de la veille suffit : l’alerte passe en critique sans attendre la sonde', async () => {
    await receive(certificate(inDays(4)), clock.now());
    await run(r15CertificateExpiry);
    clock.advance(1.5 * DAY_MS);
    await run(r15CertificateExpiry);
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', hits: 2, summary: 'Le certificat de vortex.test:443 expire dans 2 jours (2026-11-07)' });
  });

  test('dernière mesure sans date (hôte injoignable) : rien sur l’expiration', async () => {
    await receive(certificate(inDays(5)), ago(2 * MINUTE_MS));
    await receive(certificate(null), ago(MINUTE_MS));
    expect(await run(r15CertificateExpiry)).toMatchObject({ findings: 0 });
  });
});

describe('R17 : espace disque', () => {
  test('sous 15 % : élevée ; sous 5 % : critique ; 15 % pile : rien', async () => {
    await receive(disk(12.3, '/'), ago(MINUTE_MS));
    await receive(disk(4.9, '/var/lib/postgresql'), ago(MINUTE_MS));
    await receive(disk(15, '/srv'), ago(MINUTE_MS));
    await run(r17DiskSpace);
    expect((await alerts()).map((row) => [row.key, row.severity, row.summary])).toEqual([
      ['/', 'high', 'Espace disque libre sur / : 12,3 %'],
      ['/var/lib/postgresql', 'critical', 'Espace disque libre sur /var/lib/postgresql : 4,9 %'],
    ]);
  });

  test('seule la dernière mesure compte, et une mesure en échec est ignorée', async () => {
    await receive(disk(9, '/'), ago(10 * MINUTE_MS));
    await receive(disk(40, '/'), ago(5 * MINUTE_MS));
    await receive(disk(0, '/', 'failure'), ago(MINUTE_MS));
    expect(await run(r17DiskSpace)).toMatchObject({ findings: 0 });
  });

  test('bord de fenêtre : une mesure de plus de 15 min est trop ancienne', async () => {
    await receive(disk(3, '/'), ago(15 * MINUTE_MS));
    expect(await run(r17DiskSpace)).toMatchObject({ findings: 0 });
  });
});

describe('moteur : une alerte par constat', () => {
  const failingThrice = async () => {
    for (const offset of [90, 60, 30]) await receive(probe('failure'), ago(offset * SECOND));
  };

  test('deux moteurs en parallèle sur la même règle ne doublent pas l’alerte', async () => {
    await failingThrice();
    const results = await Promise.all([run(r01ProbeDown), run(r01ProbeDown), run(r01ProbeDown)]);
    expect(results.filter((result) => result.status === 'evaluated')).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  test('un même instant n’est évalué qu’une fois', async () => {
    await failingThrice();
    await run(r01ProbeDown);
    expect(await run(r01ProbeDown)).toEqual({ status: 'skipped', reason: 'up_to_date' });
    expect((await alerts())[0]!.hits).toBe(1);
  });

  test('un constat invalide annule tout le cycle : ni alerte, ni point de reprise avancé', async () => {
    const id = await receive(probe('failure'), ago(SECOND));
    const broken: Rule = {
      ...r01ProbeDown,
      id: 'TEST',
      evaluate: async () => [
        { key: 'a', severity: 'high', summary: 'valide', evidence: [id] },
        { key: 'b', severity: 'extreme' as never, summary: 'invalide', evidence: [id] },
      ],
    };
    await expect(run(broken)).rejects.toThrow();
    expect(await alerts()).toHaveLength(0);
    expect((await db.admin.query("SELECT 1 FROM sentinel.rule_checkpoint WHERE rule_id = 'TEST'")).rowCount).toBe(0);
  });

  test('une règle en échec n’empêche pas les autres d’être évaluées', async () => {
    await failingThrice();
    const errors: string[] = [];
    const broken: Rule = { ...r17DiskSpace, id: 'TEST', evaluate: async () => Promise.reject(new Error('panne')) };
    const results = await runEngineCycle(db.appPool, [broken, r01ProbeDown], clock, (rule) => errors.push(rule.id));
    expect(errors).toEqual(['TEST']);
    expect(results.R01).toMatchObject({ status: 'evaluated', opened: 1 });
  });

  test('le rôle applicatif ne peut pas supprimer une alerte', async () => {
    await failingThrice();
    await run(r01ProbeDown);
    const error = await db.appPool.query('DELETE FROM sentinel.alert').then(() => null, (failure: { code?: string }) => failure);
    expect(error?.code).toBe('42501');
  });
});
