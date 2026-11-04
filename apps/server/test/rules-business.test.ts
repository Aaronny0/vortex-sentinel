import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eventInputSchema, type EventInput } from '@sentinel/schema';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runRule } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { r10RefundSpike } from '../src/rules/r10-refund-spike.ts';
import { r11CashGap } from '../src/rules/r11-cash-gap.ts';
import { r12StockAdjustments } from '../src/rules/r12-stock-adjustments.ts';
import { r13OffHours } from '../src/rules/r13-off-hours.ts';
import { DAY_MS, MINUTE_MS, type Rule } from '../src/rules/types.ts';
import { createTestDb, type TestDb } from './db.ts';

/** Règles métier : elles évaluent « maintenant − 60 s » ; `before(ms)` place un événement par rapport à cet instant. */
const START = '2026-11-04T14:00:00.000Z';
const clock = manualClock(START);
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await ensurePartitions(db.appPool, manualClock('2026-10-01T00:00:00Z'), 4);
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  clock.set(START);
  await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint');
});

const before = (ms: number) => new Date(clock.now().getTime() - MINUTE_MS - ms);
const organizationId = '21b9a0c8-3d7e-4f61-9a2b-5c4d3e2f1a05';
const storeId = '7c6b5a49-3827-4615-a4b3-c2d1e0f9a806';
const cashier = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c04';
const otherCashier = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d06';
const product = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e07';
let sequence = 0;

const operation = (type: string, at: Date, options: { amount?: number; quantity?: number; member?: string; subjectId?: string } = {}): EventInput =>
  eventInputSchema.parse({
    id: randomUUID(),
    schemaVersion: 1,
    occurredAt: at.toISOString(),
    source: 'vortex-api',
    category: 'business',
    type,
    outcome: 'success',
    actor: { membershipId: options.member ?? cashier, role: 'cashier' },
    tenant: { organizationId, storeId },
    business: {
      operationType: type,
      reference: `REF-2026-${String((sequence += 1)).padStart(6, '0')}`,
      ...(options.amount !== undefined && { amount: options.amount, currency: 'XOF' }),
      ...(options.quantity !== undefined && { quantity: options.quantity }),
    },
    ...(options.subjectId && { attributes: { subjectId: options.subjectId } }),
  });
const receive = async (...events: EventInput[]) => {
  for (const event of events) await storeBatch(db.ingestPool, [event], new Date(event.occurredAt));
  return events.map((event) => event.id);
};
const run = (rule: Rule) => runRule(db.appPool, rule, clock);
const alerts = async () => (await db.admin.query('SELECT rule_id, key, severity, summary, evidence::text[] AS evidence FROM sentinel.alert ORDER BY first_seen_at, key')).rows;

describe('R10 : retours et remboursements anormaux', () => {
  test('4 en 24 h pour un membre qui en fait d’habitude 1 par semaine : moyenne', async () => {
    for (let week = 1; week <= 4; week += 1) await receive(operation('sale.refund', before(week * 7 * DAY_MS), { amount: 10_000 }));
    const ids = await receive(...[4, 3, 2, 1].map((hour) => operation(hour % 2 ? 'sale.refund' : 'sale.return', before(hour * 60 * MINUTE_MS), { amount: 15_000 })));
    await run(r10RefundSpike);
    expect(await alerts()).toEqual([
      expect.objectContaining({
        key: `membre ${cashier}`,
        severity: 'medium',
        summary: `4 retours ou remboursements en 24 h par le membre ${cashier.slice(0, 8)} (moyenne : 0,1 par jour), 60000 au total`,
        evidence: ids,
      }),
    ]);
  });

  test('2 seulement, ou un rythme habituel (3 par jour depuis un mois) : rien', async () => {
    await receive(...[1, 2].map((hour) => operation('sale.refund', before(hour * 60 * MINUTE_MS), { member: otherCashier })));
    for (let day = 1; day <= 30; day += 1)
      await receive(...[1, 2, 3].map((hour) => operation('sale.refund', before(day * DAY_MS + hour * 60 * MINUTE_MS))));
    await receive(...[1, 2, 3].map((hour) => operation('sale.refund', before(hour * 60 * MINUTE_MS))));
    expect(await run(r10RefundSpike)).toMatchObject({ findings: 0 });
  });
});

describe('R11 : écarts de caisse', () => {
  test('écart au-delà du seuil, en plus ou en moins : moyenne ; dans le seuil : rien', async () => {
    const [short] = await receive(operation('cash.close', before(MINUTE_MS), { amount: -12_500 }));
    await receive(operation('cash.close', before(2 * MINUTE_MS), { amount: 25_000, member: otherCashier }), operation('cash.close', before(3 * MINUTE_MS), { amount: -10_000, member: otherCashier }));
    await run(r11CashGap);
    const rows = await alerts();
    expect(rows.map((row) => [row.severity, row.summary])).toEqual([
      ['medium', expect.stringMatching(/^Clôture de caisse REF-2026-\d{6} avec un écart de -12500 XOF \(membre 1a2b3c4d\)$/)],
      ['medium', expect.stringMatching(/^Clôture de caisse REF-2026-\d{6} avec un écart de \+25000 XOF \(membre 2b3c4d5e\)$/)],
    ]);
    expect(rows[0]!.evidence).toEqual([short]);
  });

  test('3 petits manques en 30 jours pour un même caissier : élevée', async () => {
    await receive(operation('cash.close', before(20 * DAY_MS), { amount: -500 }), operation('cash.close', before(9 * DAY_MS), { amount: -1_500 }));
    expect(await run(r11CashGap)).toMatchObject({ findings: 0 });
    clock.advance(MINUTE_MS);
    await receive(operation('cash.close', before(MINUTE_MS), { amount: -2_000 }));
    await run(r11CashGap);
    expect((await alerts()).map((row) => [row.key, row.severity, row.summary])).toEqual([
      [`caissier ${cashier}`, 'high', `3 clôtures en manque en 30 jours pour le membre ${cashier.slice(0, 8)} (total -4000)`],
    ]);
  });

  test('bord de fenêtre : un manque de plus de 30 jours ne compte pas', async () => {
    await receive(operation('cash.close', before(30 * DAY_MS), { amount: -500 }), operation('cash.close', before(5 * DAY_MS), { amount: -500 }), operation('cash.close', before(MINUTE_MS), { amount: -500 }));
    expect(await run(r11CashGap)).toMatchObject({ findings: 0 });
  });
});

describe('R12 : pertes de stock répétées', () => {
  test('3 ajustements négatifs sur un produit en 7 jours : moyenne ; 2, ou un positif, ou sur 8 jours : rien', async () => {
    await receive(
      operation('stock.adjust', before(6 * DAY_MS), { quantity: -1, amount: -30_000, subjectId: product }),
      operation('stock.adjust', before(3 * DAY_MS), { quantity: 2, amount: 60_000, subjectId: product }),
      operation('stock.adjust', before(8 * DAY_MS), { quantity: -1, amount: -30_000, subjectId: product }),
      operation('stock.adjust', before(2 * DAY_MS), { quantity: -2, amount: -60_000, subjectId: product, member: otherCashier }),
    );
    clock.advance(SECOND());
    expect(await run(r12StockAdjustments)).toMatchObject({ findings: 0 });
    clock.advance(MINUTE_MS);
    await receive(operation('stock.adjust', before(MINUTE_MS), { quantity: -1, amount: -30_000, subjectId: product }));
    await run(r12StockAdjustments);
    expect((await alerts()).map((row) => row.summary)).toEqual([`3 ajustements négatifs en 7 jours sur le produit ${product.slice(0, 8)} (4 unités, 2 membres)`]);
  });
});

describe('R13 : opération hors des horaires habituels', () => {
  /** 120 opérations sur 30 jours, à 09 h, 11 h, 13 h et 15 h UTC. */
  const habits = async () => {
    for (let day = 1; day <= 30; day += 1)
      for (const hour of [9, 11, 13, 15]) await receive(operation('sale.create', new Date(Date.parse(START) - day * DAY_MS - (14 - hour) * 60 * MINUTE_MS)));
  };

  test('remboursement à 03 h pour une boutique qui travaille de jour : faible, sans incident', async () => {
    await habits();
    clock.set('2026-11-04T03:10:00.000Z');
    await receive(operation('sale.refund', before(MINUTE_MS), { amount: 50_000 }));
    await run(r13OffHours);
    expect(await alerts()).toEqual([expect.objectContaining({ severity: 'low', summary: expect.stringMatching(/^sale\.refund REF-2026-\d{6} à 03 h UTC, heure inhabituelle pour la boutique 7c6b5a49 \(0 % de son activité\)$/) })]);
    expect(Number((await db.admin.query('SELECT count(*) FROM sentinel.incident')).rows[0].count)).toBe(0);
  });

  test('heure habituelle, ou boutique sans historique suffisant : rien', async () => {
    await habits();
    await receive(operation('sale.refund', before(MINUTE_MS)));
    expect(await run(r13OffHours)).toMatchObject({ findings: 0 });
    await db.admin.query('TRUNCATE sentinel.event, sentinel.event_key, sentinel.rule_checkpoint');
    clock.set('2026-11-04T03:10:00.000Z');
    await receive(operation('sale.create', before(DAY_MS)), operation('cash.movement', before(MINUTE_MS), { amount: -5_000 }));
    expect(await run(r13OffHours)).toMatchObject({ findings: 0 });
  });
});

function SECOND() {
  return 1000;
}
