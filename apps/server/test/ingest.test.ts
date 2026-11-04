import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exampleEvents, MAX_BATCH_EVENTS, type EventInput } from '@sentinel/schema';
import { createApp } from '../src/app.ts';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { MAX_INGEST_BYTES } from '../src/ingest/ingest-plugin.ts';
import { sign } from '../src/ingest/signature.ts';
import { createTestDb, type TestDb } from './db.ts';

const secret = 'c'.repeat(64);
const clock = manualClock('2026-11-03T14:32:15.000Z');
let db: TestDb;
let app: ReturnType<typeof createApp>;

const event = (base: EventInput = exampleEvents.loginFailure): EventInput => ({ ...base, id: randomUUID() });

/** Requête signée comme le ferait l'émetteur, à l'heure de l'horloge de test. */
const signedRequest = (payload: unknown, options: { secret?: string; timestamp?: string; raw?: string } = {}) => {
  const body = options.raw ?? JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(clock.now().getTime() / 1000));
  return new Request('http://sentinel.test/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sentinel-timestamp': timestamp, 'x-sentinel-signature': sign(options.secret ?? secret, timestamp, body) },
    body,
  });
};

const batch = (events: unknown[]) => ({ sentAt: clock.now().toISOString(), events });

const send = async (request: Request) => {
  const response = await app.handle(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** Chaque envoi a son horodatage : sans cela, deux lots identiques auraient la même signature (rejeu). */
const sendBatch = async (events: unknown[]) => {
  clock.advance(1000);
  return send(signedRequest(batch(events)));
};

const countEvents = async () => Number((await db.admin.query('SELECT count(*) FROM sentinel.event')).rows[0].count);

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, clock);
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key');
  app = createApp({ ingestPool: db.ingestPool, appPool: db.appPool, clock, secrets: [secret], operatorSecretKey: Buffer.alloc(32, 7), dashboardOrigin: 'http://sentinel.test' });
});

describe('ingestion : réussite', () => {
  test('enregistre un lot signé et extrait les colonnes de recherche', async () => {
    const login = event();
    const refund = event(exampleEvents.saleRefund);
    const result = await sendBatch([login, refund]);
    expect(result).toEqual({ status: 202, body: { accepted: 2, duplicates: 0 } });

    const { rows } = await db.admin.query(
      `SELECT id, type, category, outcome, host(ip) AS ip, email_hash, http_status, organization_id, user_id,
              received_at, tableoid::regclass::text AS partition
       FROM sentinel.event ORDER BY type`,
    );
    expect(rows).toHaveLength(2);
    const [stored, sale] = rows;
    expect(stored).toMatchObject({ id: login.id, type: 'auth.login', category: 'security', outcome: 'failure', ip: '203.0.113.37', http_status: 401 });
    expect(stored.email_hash).toBe(exampleEvents.loginFailure.actor.emailHash);
    expect(sale).toMatchObject({ id: refund.id, organization_id: refund.tenant!.organizationId, user_id: refund.actor!.userId });
    // received_at vient de l'horloge de Sentinel, pas de l'émetteur ; l'événement est dans la partition du mois.
    expect(stored.received_at.toISOString()).toBe(clock.now().toISOString());
    expect(stored.partition).toBe('sentinel.event_2026_11');
  });

  test('un renvoi du même lot est compté en doublons, sans nouvelle ligne', async () => {
    const events = [event(), event()];
    await sendBatch(events);
    expect(await sendBatch(events)).toEqual({ status: 202, body: { accepted: 0, duplicates: 2 } });
    expect(await countEvents()).toBe(2);
  });

  test('un identifiant présent deux fois dans un lot n’est enregistré qu’une fois', async () => {
    const once = event();
    expect((await sendBatch([once, once, event()])).body).toEqual({ accepted: 2, duplicates: 1 });
    expect(await countEvents()).toBe(2);
  });

  test('conserve l’événement complet tel que validé', async () => {
    const refund = event(exampleEvents.saleRefund);
    await sendBatch([refund]);
    const { rows } = await db.admin.query('SELECT body FROM sentinel.event WHERE id = $1', [refund.id]);
    expect(rows[0].body).toEqual(refund);
  });
});

describe('ingestion : refus', () => {
  test('refuse une signature fausse, sans rien enregistrer', async () => {
    const result = await send(signedRequest(batch([event()]), { secret: 'd'.repeat(64) }));
    expect(result).toEqual({ status: 401, body: { code: 'BAD_SIGNATURE', error: 'Signature refusée.' } });
    expect(await countEvents()).toBe(0);
  });

  test('refuse une requête sans en-têtes de signature', async () => {
    const response = await app.handle(new Request('http://sentinel.test/ingest', { method: 'POST', body: JSON.stringify(batch([event()])) }));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('MISSING_TIMESTAMP');
  });

  test('refuse un horodatage trop ancien', async () => {
    const old = String(Math.floor(clock.now().getTime() / 1000) - 301);
    expect((await send(signedRequest(batch([event()]), { timestamp: old }))).body.code).toBe('STALE_REQUEST');
  });

  test('refuse le rejeu exact d’une requête acceptée', async () => {
    clock.advance(1000);
    const payload = batch([event()]);
    expect((await send(signedRequest(payload))).status).toBe(202);
    const replay = await send(signedRequest(payload));
    expect(replay).toEqual({ status: 401, body: { code: 'REPLAYED', error: 'Requête déjà reçue.' } });
  });

  test('refuse tout le lot si un événement est invalide, avec le champ fautif', async () => {
    const result = await sendBatch([event(), { ...event(), type: 'auth.hack' }]);
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('VALIDATION_FAILED');
    expect(result.body.fields).toHaveProperty(['events.1.type']);
    expect(await countEvents()).toBe(0);
  });

  test('refuse un lot vide ou trop gros', async () => {
    expect((await sendBatch([])).status).toBe(422);
    const tooMany = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => event());
    expect((await sendBatch(tooMany)).status).toBe(422);
  });

  test('refuse un corps illisible, même correctement signé', async () => {
    clock.advance(1000);
    expect((await send(signedRequest(null, { raw: '{"sentAt":' }))).body).toEqual({ code: 'INVALID_BODY', error: 'Le corps de la requête est illisible.' });
  });

  test('refuse un corps de plus de 1 Mo', async () => {
    clock.advance(1000);
    const result = await send(signedRequest(null, { raw: 'x'.repeat(MAX_INGEST_BYTES + 1) }));
    expect(result).toEqual({ status: 413, body: { code: 'BODY_TOO_LARGE', error: 'Le lot est trop volumineux.' } });
  });
});

describe('ingestion : débit', () => {
  test('au-delà du débit autorisé : 429 avec Retry-After, rien d’enregistré ; la minute suivante repasse', async () => {
    clock.set('2026-11-03T14:40:00.000Z');
    const local = createApp({ ingestPool: db.ingestPool, appPool: db.appPool, clock, secrets: [secret], operatorSecretKey: Buffer.alloc(32, 7), dashboardOrigin: 'http://sentinel.test', ingestRate: { batchesPerMinute: 2, eventsPerMinute: 1_000 } });
    const post = async () => {
      clock.advance(1000);
      const response = await local.handle(signedRequest(batch([event()])));
      return { status: response.status, retryAfter: response.headers.get('retry-after') };
    };
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    expect(await post()).toEqual({ status: 429, retryAfter: '57' });
    expect(await countEvents()).toBe(2);
    clock.advance(60_000);
    expect((await post()).status).toBe(202);
  });
});

describe('santé de Sentinel', () => {
  test('moteur à jour : ok ; sans cycle depuis plus de 2 min : dégradée (503)', async () => {
    const health = async () => {
      const response = await app.handle(new Request('http://sentinel.test/health'));
      return { status: response.status, body: (await response.json()) as { status: string; engine: { lagSeconds: number | null } } };
    };
    await db.admin.query('TRUNCATE sentinel.rule_checkpoint');
    expect(await health()).toMatchObject({ status: 200, body: { status: 'ok', engine: { lagSeconds: null } } });
    await db.admin.query(`INSERT INTO sentinel.rule_checkpoint VALUES ('R01', $1, $1)`, [new Date(clock.now().getTime() - 30_000)]);
    expect(await health()).toMatchObject({ status: 200, body: { status: 'ok', engine: { lagSeconds: 30 } } });
    clock.advance(120_000);
    expect(await health()).toMatchObject({ status: 503, body: { status: 'degraded' } });
  });
});

describe('ingestion : concurrence', () => {
  test('deux lots simultanés portant les mêmes événements ne les enregistrent qu’une fois', async () => {
    const events = Array.from({ length: 50 }, () => event());
    clock.advance(1000);
    const first = signedRequest(batch(events));
    clock.advance(1000);
    const second = signedRequest(batch(events));
    const results = await Promise.all([send(first), send(second)]);
    const accepted = results.reduce((sum, result) => sum + (result.body.accepted as number), 0);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(accepted).toBe(50);
    expect(await countEvents()).toBe(50);
  });
});

describe('base : droits des rôles', () => {
  const refused = async (pool: TestDb['ingestPool'], sql: string) => {
    const error = await pool.query(sql).then(() => null, (failure: { code?: string }) => failure);
    expect(error?.code).toBe('42501'); // insufficient_privilege
  };

  beforeEach(async () => {
    await sendBatch([event()]);
  });

  test('le rôle d’ingestion ne lit ni ne modifie les événements', async () => {
    await refused(db.ingestPool, 'SELECT * FROM sentinel.event');
    await refused(db.ingestPool, "UPDATE sentinel.event SET outcome = 'success'");
    await refused(db.ingestPool, 'DELETE FROM sentinel.event');
    await refused(db.ingestPool, 'DELETE FROM sentinel.event_key');
  });

  test('le rôle applicatif lit les événements mais ne peut ni les modifier ni en ajouter', async () => {
    expect(Number((await db.appPool.query('SELECT count(*) FROM sentinel.event')).rows[0].count)).toBe(1);
    await refused(db.appPool, "UPDATE sentinel.event SET outcome = 'success'");
    await refused(db.appPool, 'DELETE FROM sentinel.event');
    await refused(db.appPool, 'TRUNCATE sentinel.event');
    await refused(db.appPool, 'INSERT INTO sentinel.event_key (id, received_at) VALUES (gen_random_uuid(), now())');
  });

  test('les partitions sont créées une seule fois, et seulement dans les bornes', async () => {
    expect(await ensurePartitions(db.appPool, clock)).toBe(0);
    const error = await db.appPool.query('SELECT sentinel.ensure_event_partitions(current_date, 25)').then(() => null, (failure: Error) => failure);
    expect(error?.message).toContain('Nombre de mois invalide');
  });
});
