import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { minimum: 3, factor: 3, historyDays: 30 };

/**
 * R10 — Retours et remboursements anormaux : sur les dernières 24 h, un membre en enregistre au moins 3 et plus de 3 fois
 * sa moyenne quotidienne des 30 jours précédents. La référence est calculée à la volée sur 30 jours (bornés, indexés) :
 * même événements, même résultat, sans table de références à tenir à jour.
 */
export const r10RefundSpike: Rule = {
  id: 'R10',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: 60 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ member: string; organization: string; today: number; history: number; ids: string[]; total: number | null }>(
      `WITH refunds AS (
         SELECT id, received_at, organization_id, body->'actor'->>'membershipId' AS member, (body->'business'->>'amount')::bigint AS amount
         FROM sentinel.event
         WHERE type IN ('sale.refund', 'sale.return')
           AND received_at > $1::timestamptz - make_interval(days => $2::int + 1) AND received_at <= $1
       )
       SELECT member, organization_id::text AS organization,
              count(*) FILTER (WHERE received_at > $1::timestamptz - interval '1 day')::int AS today,
              count(*) FILTER (WHERE received_at <= $1::timestamptz - interval '1 day')::int AS history,
              (array_agg(id ORDER BY received_at, id) FILTER (WHERE received_at > $1::timestamptz - interval '1 day'))[1:100] AS ids,
              sum(amount) FILTER (WHERE received_at > $1::timestamptz - interval '1 day')::float8 AS total
       FROM refunds WHERE member IS NOT NULL
       GROUP BY member, organization_id
       HAVING count(*) FILTER (WHERE received_at > $1::timestamptz - interval '1 day') >= $3`,
      [at, thresholds.historyDays, thresholds.minimum],
    );
    return rows
      .filter((row) => row.today > thresholds.factor * (row.history / thresholds.historyDays))
      .map((row) => ({
        key: `membre ${row.member}`,
        severity: 'medium',
        summary: `${count(row.today, 'retour ou remboursement', 'retours ou remboursements')} en 24 h par le membre ${row.member.slice(0, 8)} (moyenne : ${String(Math.round((row.history / thresholds.historyDays) * 10) / 10).replace('.', ',')} par jour)${row.total ? `, ${row.total} au total` : ''}`,
        evidence: row.ids,
      }));
  },
};

