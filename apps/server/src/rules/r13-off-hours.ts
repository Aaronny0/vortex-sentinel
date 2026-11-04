import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { historyDays: 30, minHistory: 50, rarePercent: 1, windowMinutes: 15 };

/**
 * R13 — Opération hors des horaires habituels : un remboursement ou une opération de caisse, à une heure où la boutique
 * fait moins de 1 % de son activité des 30 derniers jours. Il faut au moins 50 opérations d'historique : une boutique
 * nouvelle n'a pas encore d'habitudes. L'heure est celle de l'événement (UTC), cohérente pour une boutique donnée.
 * Gravité faible : une alerte à examiner, qui n'ouvre pas d'incident.
 */
export const r13OffHours: Rule = {
  id: 'R13',
  version: 1,
  kind: 'window',
  severity: 'low',
  graceMs: MINUTE_MS,
  quietMs: 60 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ id: string; type: string; reference: string; store: string; hour: number; share: number }>(
      `WITH recent AS (
         SELECT id, type, store_id, body->'business'->>'reference' AS reference, extract(hour FROM occurred_at AT TIME ZONE 'UTC')::int AS hour
         FROM sentinel.event
         WHERE type IN ('sale.refund', 'cash.open', 'cash.close', 'cash.movement') AND store_id IS NOT NULL
           AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       ),
       habits AS (
         SELECT store_id, extract(hour FROM occurred_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS n,
                sum(count(*)) OVER (PARTITION BY store_id) AS total
         FROM sentinel.event
         WHERE category = 'business' AND store_id IN (SELECT store_id FROM recent)
           AND received_at > $1::timestamptz - make_interval(days => $3) AND received_at <= $1::timestamptz - make_interval(mins => $2)
         GROUP BY store_id, 2
       )
       SELECT r.id, r.type, r.reference, r.store_id::text AS store, r.hour,
              coalesce(h.n, 0)::float8 * 100 / t.total AS share
       FROM recent r
       JOIN (SELECT DISTINCT store_id, total FROM habits) t ON t.store_id = r.store_id
       LEFT JOIN habits h ON h.store_id = r.store_id AND h.hour = r.hour
       WHERE t.total >= $4 AND coalesce(h.n, 0)::float8 * 100 / t.total < $5
       ORDER BY r.id`,
      [at, thresholds.windowMinutes, thresholds.historyDays, thresholds.minHistory, thresholds.rarePercent],
    );
    return rows.map((row) => ({
      key: `opération ${row.reference ?? row.id}`,
      severity: 'low',
      summary: `${row.type} ${row.reference ?? ''} à ${String(row.hour).padStart(2, '0')} h UTC, heure inhabituelle pour la boutique ${row.store.slice(0, 8)} (${String(Math.round(row.share * 10) / 10).replace('.', ',')} % de son activité)`.replace('  ', ' '),
      evidence: [row.id],
    }));
  },
};
