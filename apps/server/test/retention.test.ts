import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exampleEvents } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { purgeExpired } from '../src/db/retention.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { createTestDb, type TestDb } from './db.ts';

let db: TestDb;
const partitions = async () =>
  (await db.admin.query(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'sentinel.event'::regclass ORDER BY 1`)).rows.map((row) => row.relname);
const store = (at: string) => storeBatch(db.ingestPool, [{ ...exampleEvents.loginFailure, id: randomUUID() }], new Date(at));

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

describe('rétention', () => {
  test('supprime les mois de plus de 2 ans et les clés de plus de 30 jours, garde le reste', async () => {
    await ensurePartitions(db.appPool, manualClock('2024-09-15T00:00:00Z'), 3);
    await ensurePartitions(db.appPool, manualClock('2026-10-01T00:00:00Z'), 2);
    await store('2024-09-20T10:00:00Z');
    await store('2024-11-02T10:00:00Z');
    await store('2026-10-20T10:00:00Z');
    await store('2026-11-01T10:00:00Z');

    const result = await purgeExpired(db.appPool, manualClock('2026-11-04T14:00:00Z'));
    // Novembre 2024 a moins de 2 ans révolus au 4 novembre 2026 : il est gardé ; septembre et octobre 2024 partent.
    expect(result).toEqual({ droppedPartitions: 2, deletedKeys: 2 });
    expect(await partitions()).toEqual(['event_2024_11', 'event_2026_10', 'event_2026_11', 'event_default']);
    expect(Number((await db.admin.query('SELECT count(*) FROM sentinel.event')).rows[0].count)).toBe(3);
    expect(await purgeExpired(db.appPool, manualClock('2026-11-04T14:00:00Z'))).toEqual({ droppedPartitions: 0, deletedKeys: 0 });
  });

  test('refuse une date de purge dans le futur ; le rôle applicatif ne peut pas supprimer d’événements lui-même', async () => {
    expect(await purgeExpired(db.appPool, manualClock('2099-01-01T00:00:00Z')).then(() => null, (error: Error) => error.message)).toContain('futur');
    const error = await db.appPool.query('DROP TABLE sentinel.event_2026_11').then(() => null, (failure: { code?: string }) => failure);
    expect(error?.code).toBe('42501');
  });
});
