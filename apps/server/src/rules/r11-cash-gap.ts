import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { gapAmount: 10_000, repeatedShortages: 3, historyDays: 30, windowMinutes: 15 };

/**
 * R11 — Écarts de caisse : une clôture avec un écart (compté − théorique) au-delà du seuil, en plus ou en moins, est
 * moyenne ; 3 manques pour un même caissier en 30 jours sont élevés, même petits (ils s'accumulent sans se voir).
 * Le seuil est en unités de la devise de l'entreprise.
 */
export const r11CashGap: Rule = {
  id: 'R11',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: 60 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const closes = await query<{ id: string; reference: string; gap: number; currency: string | null; member: string | null }>(
      `SELECT id, body->'business'->>'reference' AS reference, (body->'business'->>'amount')::float8 AS gap,
              body->'business'->>'currency' AS currency, body->'actor'->>'membershipId' AS member
       FROM sentinel.event
       WHERE type = 'cash.close' AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
         AND abs((body->'business'->>'amount')::float8) > $3
       ORDER BY received_at, id`,
      [at, thresholds.windowMinutes, thresholds.gapAmount],
    );
    const repeated = await query<{ member: string; shortages: number; ids: string[]; total: number }>(
      `SELECT body->'actor'->>'membershipId' AS member, count(*)::int AS shortages,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids, sum((body->'business'->>'amount')::float8) AS total
       FROM sentinel.event
       WHERE type = 'cash.close' AND (body->'business'->>'amount')::float8 < 0
         AND received_at > $1::timestamptz - make_interval(days => $2) AND received_at <= $1
         AND body->'actor'->>'membershipId' IS NOT NULL
       GROUP BY 1
       HAVING count(*) >= $3
          AND max(received_at) > $1::timestamptz - make_interval(mins => $4)`,
      [at, thresholds.historyDays, thresholds.repeatedShortages, thresholds.windowMinutes],
    );
    const money = (value: number, currency: string | null) => `${value > 0 ? '+' : ''}${value}${currency ? ` ${currency}` : ''}`;
    return [
      ...closes.map((row) => ({
        key: `clôture ${row.reference}`,
        severity: 'medium' as const,
        summary: `Clôture de caisse ${row.reference} avec un écart de ${money(row.gap, row.currency)}${row.member ? ` (membre ${row.member.slice(0, 8)})` : ''}`,
        evidence: [row.id],
      })),
      ...repeated.map((row) => ({
        key: `caissier ${row.member}`,
        severity: 'high' as const,
        summary: `${row.shortages} clôtures en manque en ${thresholds.historyDays} jours pour le membre ${row.member.slice(0, 8)} (total ${money(row.total, null)})`,
        evidence: row.ids,
      })),
    ];
  },
};
