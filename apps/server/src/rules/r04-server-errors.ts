import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { errorPercent: 5, minRequests: 20, windowMinutes: 5 };

/**
 * R04 — Taux d'erreurs serveur : plus de 5 % de réponses 5xx sur 5 min, toutes routes confondues, à partir de 20 requêtes
 * (en dessous, une seule erreur ferait déjà 5 %).
 */
export const r04ServerErrors: Rule = {
  id: 'R04',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ source: string; requests: number; errors: number; ids: string[] }>(
      `SELECT source, sum((body->'attributes'->>'count')::int)::int AS requests,
              sum((body->'attributes'->>'serverErrors')::int)::int AS errors,
              (array_agg(id ORDER BY received_at, id) FILTER (WHERE (body->'attributes'->>'serverErrors')::int > 0))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'http.metrics' AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY source
       ORDER BY source`,
      [at, thresholds.windowMinutes],
    );
    return rows
      .filter((row) => row.requests >= thresholds.minRequests && row.errors * 100 > row.requests * thresholds.errorPercent && row.ids?.length)
      .map((row) => ({
        key: row.source,
        severity: 'high',
        summary: `${String(Math.round((row.errors / row.requests) * 1000) / 10).replace('.', ',')} % d'erreurs serveur sur ${thresholds.windowMinutes} min (${row.errors} sur ${count(row.requests, 'requête')})`,
        evidence: row.ids,
      }));
  },
};
