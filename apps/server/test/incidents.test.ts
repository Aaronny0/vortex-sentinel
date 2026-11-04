import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { AppError } from '../src/common/errors.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { incidentReference, transitionIncident, type TransitionInput } from '../src/incidents/transitions.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { r01ProbeDown } from '../src/rules/r01-probe-down.ts';
import { r05AccountBruteForce } from '../src/rules/r05-account-brute-force.ts';
import { r07Compromise } from '../src/rules/r07-compromise.ts';
import { MINUTE_MS, type Rule, type Severity } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

const START = '2026-11-04T14:00:00.000Z';
const SECOND = 1000;
const clock = manualClock(START);
let db: TestDb;
const analyst = randomUUID();
const otherAnalyst = randomUUID();

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
  for (const [id, name] of [[analyst, 'Analyste A'], [otherAnalyst, 'Analyste B']])
    await db.admin.query(
      `INSERT INTO sentinel.operator (id, email, name, role, password_hash, created_at, updated_at) VALUES ($1, $2, $3, 'analyst', 'x', now(), now())`,
      [id, `${id}@sentinel.test`, name],
    );
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  clock.set(START);
  await db.admin.query(
    'TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint',
  );
});

const hash = (name: string) => createHash('sha256').update(name).digest('hex');
const build = (partial: Partial<EventInput> & Pick<EventInput, 'type' | 'category' | 'outcome' | 'source'>) =>
  eventInputSchema.parse({ id: randomUUID(), schemaVersion: 1, occurredAt: clock.now().toISOString(), ...partial });
const login = (outcome: 'success' | 'failure', who: string, at: Date) => ({
  event: build({ source: 'vortex-api', type: 'auth.login', category: 'security', outcome, actor: { emailHash: hash(who) }, network: { ip: '198.51.100.9' } }),
  at,
});
const probe = (outcome: 'success' | 'failure', at: Date) => ({
  event: build({ source: 'sentinel-probe', type: 'probe.check', category: 'availability', outcome, attributes: { target: 'vortex-api' } }),
  at,
});
const receive = async (...items: { event: EventInput; at: Date }[]) => {
  for (const { event, at } of items) await storeBatch(db.ingestPool, [event], at);
};
const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const run = (rule: Rule) => runRule(db.appPool, rule, clock);

const incidents = async () =>
  (await db.admin.query('SELECT id, number::text, key, title, severity, status, assignee_id, resolved_at, closed_at FROM sentinel.incident ORDER BY number')).rows;
const history = async (incidentId: string) =>
  (await db.admin.query('SELECT kind, actor_id, from_status, to_status, comment FROM sentinel.incident_history WHERE incident_id = $1 ORDER BY id', [incidentId])).rows;
const links = async () => Number((await db.admin.query('SELECT count(*) FROM sentinel.incident_alert')).rows[0].count);

/** Règle de test qui constate toujours la même clé, avec la gravité donnée. */
const fixedRule = (id: string, severity: Severity, key = 'clé-test'): Rule => ({
  id,
  version: 1,
  kind: 'window',
  severity,
  graceMs: 0,
  quietMs: MINUTE_MS,
  thresholds: {},
  async evaluate({ query }) {
    const [row] = await query<{ id: string }>('SELECT id FROM sentinel.event ORDER BY received_at LIMIT 1', []);
    return row ? [{ key, severity, summary: `constat ${id}`, evidence: [row.id] }] : [];
  },
});

/** 10 refus sur le compte d'Awa (R05), reçus avant l'instant évalué par les règles de Vortex (maintenant − 60 s). */
const bruteForce = () => receive(...Array.from({ length: 10 }, (_, i) => login('failure', 'awa', ago(MINUTE_MS + (10 - i) * 20 * SECOND))));

describe('des alertes aux incidents', () => {
  test('une alerte élevée ouvre un incident numéroté, historisé, avec l’alerte rattachée', async () => {
    await bruteForce();
    expect(await run(r05AccountBruteForce)).toMatchObject({ opened: 1, incidentsOpened: 1 });
    const [incident] = await incidents();
    expect(incident).toMatchObject({ key: hash('awa'), severity: 'high', status: 'open', title: expect.stringMatching(/^R05 · 10 connexions refusées/) });
    expect(incidentReference(incident!.number)).toMatch(/^INC-\d{6}$/);
    expect(await history(incident!.id)).toEqual([expect.objectContaining({ kind: 'opened', actor_id: null, comment: expect.stringContaining('Ouvert par R05') })]);
    expect(await links()).toBe(1);
  });

  test('R05 puis R07 sur le même compte : un seul incident, porté en critique', async () => {
    await bruteForce();
    await run(r05AccountBruteForce);
    await receive(login('success', 'awa', ago(MINUTE_MS + SECOND)));
    expect(await run(r07Compromise)).toMatchObject({ opened: 1, incidentsOpened: 0 });
    const rows = await incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', status: 'open' });
    expect((await history(rows[0]!.id)).map((entry) => entry.kind)).toEqual(['opened', 'severity_raised', 'alert_linked']);
    expect(await links()).toBe(2);
  });

  test('une alerte faible reste une alerte ; une alerte qui dure ne crée ni lien ni incident de plus', async () => {
    await receive(probe('failure', ago(SECOND)));
    await run(fixedRule('TLOW', 'low', 'faible'));
    expect(await incidents()).toHaveLength(0);
    await run(fixedRule('THIGH', 'high'));
    clock.advance(30 * SECOND);
    expect(await run(fixedRule('THIGH', 'high'))).toMatchObject({ opened: 0, incidentsOpened: 0 });
    expect(await incidents()).toHaveLength(1);
    expect(await links()).toBe(1);
  });

  test('deux règles constatent la même clé en même temps : un seul incident, deux alertes rattachées', async () => {
    await receive(probe('failure', ago(SECOND)));
    await Promise.all([run(fixedRule('TA', 'high')), run(fixedRule('TB', 'medium')), run(fixedRule('TC', 'critical'))]);
    const rows = await incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('critical');
    expect(await links()).toBe(3);
  });
});

describe('résolution automatique', () => {
  const outage = () => receive(probe('failure', ago(90 * SECOND)), probe('failure', ago(60 * SECOND)), probe('failure', ago(30 * SECOND)));
  const recover = async () => {
    clock.advance(30 * SECOND);
    await receive(probe('success', clock.now()));
    await run(r01ProbeDown);
    clock.advance(2 * MINUTE_MS + SECOND);
    return run(r01ProbeDown);
  };

  test('service rétabli : l’incident de disponibilité est résolu par le système', async () => {
    await outage();
    await run(r01ProbeDown);
    expect(await recover()).toMatchObject({ closed: 1, incidentsResolved: 1 });
    const [incident] = await incidents();
    expect(incident).toMatchObject({ status: 'resolved', resolved_at: clock.now() });
    expect((await history(incident!.id)).at(-1)).toMatchObject({ kind: 'transition', actor_id: null, from_status: 'open', to_status: 'resolved' });
  });

  test('incident déjà pris en charge par un opérateur : il attend sa décision', async () => {
    await outage();
    await run(r01ProbeDown);
    const [incident] = await incidents();
    await transitionIncident(db.appPool, clock, { incidentId: incident!.id, to: 'acknowledged', actorId: analyst });
    expect(await recover()).toMatchObject({ incidentsResolved: 0 });
    expect((await incidents())[0]!.status).toBe('acknowledged');
  });

  test('incident de sécurité : jamais résolu automatiquement ; une nouvelle attaque après sa résolution en ouvre un autre', async () => {
    await bruteForce();
    await run(r05AccountBruteForce);
    clock.advance(25 * MINUTE_MS);
    expect(await run(r05AccountBruteForce)).toMatchObject({ closed: 1, incidentsResolved: 0 });
    const [first] = await incidents();
    expect(first!.status).toBe('open');

    for (const to of ['acknowledged', 'in_progress', 'resolved'] as const)
      await transitionIncident(db.appPool, clock, { incidentId: first!.id, to, actorId: analyst, comment: 'Mot de passe changé, IP bloquée.' });
    await bruteForce();
    clock.advance(SECOND);
    expect(await run(r05AccountBruteForce)).toMatchObject({ incidentsOpened: 1 });
    expect((await incidents()).map((row) => row.status)).toEqual(['resolved', 'open']);
  });
});

describe('cycle de vie d’un incident', () => {
  const openIncident = async () => {
    await bruteForce();
    await run(r05AccountBruteForce);
    return (await incidents())[0]!.id as string;
  };
  const refusal = async (input: TransitionInput) => {
    const error = await transitionIncident(db.appPool, clock, input).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  };

  test('parcours complet, chaque étape historisée avec son auteur ; la prise en charge assigne l’opérateur', async () => {
    const incidentId = await openIncident();
    const steps: [TransitionInput['to'], string | undefined][] = [
      ['acknowledged', undefined],
      ['in_progress', 'Analyse des connexions du compte.'],
      ['resolved', 'Mot de passe réinitialisé, adresse bloquée.'],
      ['closed', undefined],
    ];
    for (const [to, comment] of steps) {
      clock.advance(MINUTE_MS);
      await transitionIncident(db.appPool, clock, { incidentId, to, actorId: analyst, comment });
    }
    const [incident] = await incidents();
    expect(incident).toMatchObject({ status: 'closed', assignee_id: analyst, closed_at: clock.now() });
    expect((await history(incidentId)).filter((entry) => entry.kind === 'transition').map((entry) => [entry.from_status, entry.to_status, entry.actor_id])).toEqual([
      ['open', 'acknowledged', analyst],
      ['acknowledged', 'in_progress', analyst],
      ['in_progress', 'resolved', analyst],
      ['resolved', 'closed', analyst],
    ]);
  });

  test('transitions refusées : hors cycle, sans commentaire requis, incident inconnu, saisie invalide', async () => {
    const incidentId = await openIncident();
    expect(await refusal({ incidentId, to: 'resolved', actorId: analyst, comment: 'Trop tôt.' })).toMatchObject({ status: 409, code: 'INVALID_TRANSITION', message: 'Transition impossible : Ouvert → Résolu.' });
    expect(await refusal({ incidentId, to: 'false_positive', actorId: analyst })).toMatchObject({ status: 422, fields: { comment: 'Un commentaire est requis pour passer à « Faux positif ».' } });
    expect(await refusal({ incidentId: randomUUID(), to: 'acknowledged', actorId: analyst })).toMatchObject({ status: 404 });
    expect(await refusal({ incidentId, to: 'archived' as never, actorId: 'moi' })).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await incidents())[0]!.status).toBe('open');

    await transitionIncident(db.appPool, clock, { incidentId, to: 'false_positive', actorId: analyst, comment: 'Test de charge planifié.' });
    expect(await refusal({ incidentId, to: 'in_progress', actorId: analyst, comment: 'Réouverture.' })).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('réouverture d’un incident résolu : commentaire obligatoire, date de résolution effacée', async () => {
    const incidentId = await openIncident();
    for (const to of ['acknowledged', 'in_progress', 'resolved'] as const)
      await transitionIncident(db.appPool, clock, { incidentId, to, actorId: analyst, comment: 'Corrigé.' });
    expect(await refusal({ incidentId, to: 'in_progress', actorId: analyst })).toMatchObject({ status: 422 });
    await transitionIncident(db.appPool, clock, { incidentId, to: 'in_progress', actorId: analyst, comment: 'Nouvelles connexions suspectes.' });
    expect((await incidents())[0]).toMatchObject({ status: 'in_progress', resolved_at: null });
  });

  test('deux opérateurs prennent en charge en même temps : un seul y parvient', async () => {
    const incidentId = await openIncident();
    const results = await Promise.allSettled([
      transitionIncident(db.appPool, clock, { incidentId, to: 'acknowledged', actorId: analyst }),
      transitionIncident(db.appPool, clock, { incidentId, to: 'acknowledged', actorId: otherAnalyst }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await history(incidentId)).filter((entry) => entry.kind === 'transition')).toHaveLength(1);
  });

  test('l’historique ne peut être ni modifié ni effacé', async () => {
    const incidentId = await openIncident();
    for (const sql of ["UPDATE sentinel.incident_history SET comment = 'réécrit'", 'DELETE FROM sentinel.incident_history', 'DELETE FROM sentinel.incident']) {
      const error = await db.appPool.query(sql).then(() => null, (failure: { code?: string }) => failure);
      expect(error?.code).toBe('42501');
    }
    expect(await history(incidentId)).toHaveLength(1);
  });
});
