import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eventInputSchema } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { sendPendingNotifications, type Mail } from '../src/notify/notifier.ts';
import { r06CredentialStuffing } from '../src/rules/r06-credential-stuffing.ts';
import { r07Compromise } from '../src/rules/r07-compromise.ts';
import { r08AccessDenied } from '../src/rules/r08-access-denied.ts';
import { MINUTE_MS } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

const START = '2026-11-04T14:00:00.000Z';
const clock = manualClock(START);
let db: TestDb;
const ORIGIN = 'https://sentinel.example';

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
  for (const [email, role, disabled] of [['admin@sentinel.test', 'admin', false], ['analyste@sentinel.test', 'analyst', false], ['observateur@sentinel.test', 'observer', false], ['parti@sentinel.test', 'analyst', true]] as const)
    await db.admin.query(`INSERT INTO sentinel.operator (email, name, role, password_hash, disabled, created_at, updated_at) VALUES ($1, $1, $2, 'x', $3, now(), now())`, [email, role, disabled]);
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  clock.set(START);
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
});

const hash = (name: string) => createHash('sha256').update(name).digest('hex');
const event = (type: 'auth.login' | 'access.denied', outcome: 'success' | 'failure', who: string, ip: string) =>
  eventInputSchema.parse({
    id: randomUUID(), schemaVersion: 1, occurredAt: clock.now().toISOString(), source: 'vortex-api', category: 'security', type, outcome,
    actor: { emailHash: hash(who) }, network: { ip },
    ...(type === 'access.denied' && { http: { method: 'POST', route: '/api/v1/commands', status: 403, durationMs: 3 } }),
  });
const at = (ms: number) => new Date(clock.now().getTime() - MINUTE_MS - ms);
/** Bourrage d'identifiants (R06, élevée) depuis 198.51.100.7, dont une cible, compte-3, réussit ensuite à se connecter (R07, critique). */
const attack = async () => {
  for (let i = 0; i < 20; i += 1) await storeBatch(db.ingestPool, [event('auth.login', 'failure', `compte-${i % 5}`, '198.51.100.7')], at(9 * MINUTE_MS - i * 5_000));
};
const queue = async () => (await db.admin.query('SELECT kind, severity, attempts, sent_at, failed_at, last_error, next_attempt_at FROM sentinel.notification ORDER BY id')).rows;

describe('notifications : mise en file', () => {
  test('incident élevé : une notification ; porté en critique : une seconde ; moyen : aucune', async () => {
    await attack();
    await runRule(db.appPool, r06CredentialStuffing, clock);
    await storeBatch(db.ingestPool, [event('auth.login', 'success', 'compte-3', '198.51.100.7')], at(MINUTE_MS));
    await runRule(db.appPool, r07Compromise, clock);
    for (let i = 0; i < 5; i += 1) await storeBatch(db.ingestPool, [event('access.denied', 'failure', 'autre', '203.0.113.90')], at(i * 1000));
    await runRule(db.appPool, r08AccessDenied, clock);
    expect((await queue()).map((row) => [row.kind, row.severity])).toEqual([
      ['opened', 'high'],
      ['opened', 'critical'],
    ]);
    // R07 vise le compte, R06 l'adresse : deux incidents distincts ; le critique a sa propre notification.
    expect((await db.admin.query('SELECT severity FROM sentinel.incident ORDER BY number')).rows.map((row) => row.severity)).toEqual(['high', 'critical', 'medium']);
  });
});

describe('notifications : envoi', () => {
  const capture = () => {
    const mails: Mail[] = [];
    return { mails, send: async (mail: Mail) => void mails.push(mail) };
  };

  test('aux administrateurs et analystes actifs, en copie cachée ; texte expurgé ; envoyée une seule fois', async () => {
    await attack();
    await runRule(db.appPool, r06CredentialStuffing, clock);
    const { mails, send } = capture();
    expect(await sendPendingNotifications(db.appPool, clock, send, ORIGIN)).toEqual({ sent: 1, failed: 0 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.bcc).toEqual(['admin@sentinel.test', 'analyste@sentinel.test']);
    expect(mails[0]!.subject).toMatch(/^\[Sentinel\] Élevée · INC-\d{6} · R06 · 20 connexions refusées depuis ••• sur 5 comptes en 10 min$/);
    expect(mails[0]!.text).toContain(`${ORIGIN}/incidents/`);
    expect(JSON.stringify(mails)).not.toContain('198.51.100.7');
    expect(await sendPendingNotifications(db.appPool, clock, send, ORIGIN)).toEqual({ sent: 0, failed: 0 });
  });

  test('serveur de mail en panne : nouvelles tentatives espacées, puis abandon après la quatrième', async () => {
    await attack();
    await runRule(db.appPool, r06CredentialStuffing, clock);
    const down = async () => Promise.reject(Object.assign(new Error('connexion refusée'), { code: 'ECONNECTION' }));
    await sendPendingNotifications(db.appPool, clock, down, ORIGIN);
    expect((await queue())[0]).toMatchObject({ attempts: 1, last_error: 'ECONNECTION', sent_at: null, failed_at: null, next_attempt_at: new Date(clock.now().getTime() + MINUTE_MS) });
    expect(await sendPendingNotifications(db.appPool, clock, down, ORIGIN)).toEqual({ sent: 0, failed: 0 });
    for (const wait of [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 60 * MINUTE_MS]) {
      clock.advance(wait);
      await sendPendingNotifications(db.appPool, clock, down, ORIGIN);
    }
    expect((await queue())[0]).toMatchObject({ attempts: 5, failed_at: clock.now() });
  });

  test('périmée après 24 h : abandonnée sans envoi ; deux envois simultanés n’envoient qu’une fois', async () => {
    await attack();
    await runRule(db.appPool, r06CredentialStuffing, clock);
    const { mails, send } = capture();
    await Promise.all([sendPendingNotifications(db.appPool, clock, send, ORIGIN), sendPendingNotifications(db.appPool, clock, send, ORIGIN)]);
    expect(mails).toHaveLength(1);

    await db.admin.query('UPDATE sentinel.notification SET sent_at = NULL');
    clock.advance(25 * 60 * MINUTE_MS);
    expect(await sendPendingNotifications(db.appPool, clock, send, ORIGIN)).toEqual({ sent: 0, failed: 1 });
    expect((await queue())[0]).toMatchObject({ last_error: 'EXPIRED' });
  });
});
