import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { p95Ms: 2_000, consecutiveMinutes: 5, lookbackMinutes: 10 };

/**
 * R03 — Route lente : latence p95 au-dessus de 2 s pendant 5 minutes consécutives, d'après les mesures par minute et par
 * route de l'émetteur (`http.metrics`). Une minute sans trafic rompt la suite : seules des minutes consécutives comptent.
 */
export const r03SlowRoute: Rule = {
  id: 'R03',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: 5 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ method: string; route: string; ids: string[]; min_p95: number; max_p95: number }>(
      `WITH metrics AS (
         SELECT id, body->'attributes'->>'method' AS method, body->'attributes'->>'route' AS route,
                (body->'attributes'->>'p95Ms')::float8 AS p95, (body->'attributes'->>'windowStart')::timestamptz AS window_start
         FROM sentinel.event
         WHERE type = 'http.metrics' AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       ),
       ranked AS (
         SELECT *, row_number() OVER (PARTITION BY method, route ORDER BY window_start DESC, id DESC) AS rank FROM metrics
         WHERE method IS NOT NULL AND route IS NOT NULL AND p95 IS NOT NULL AND window_start IS NOT NULL
       )
       SELECT method, route, array_agg(id ORDER BY window_start) AS ids, min(p95) AS min_p95, max(p95) AS max_p95
       FROM ranked WHERE rank <= $3
       GROUP BY method, route
       HAVING count(*) = $3 AND min(p95) > $4
          AND max(window_start) - min(window_start) = make_interval(mins => $3::int - 1)
       ORDER BY method, route`,
      [at, thresholds.lookbackMinutes, thresholds.consecutiveMinutes, thresholds.p95Ms],
    );
    const seconds = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',');
    return rows.map((row) => ({
      key: `${row.method} ${row.route}`,
      severity: 'medium',
      summary: `${row.method} ${row.route} lente depuis ${thresholds.consecutiveMinutes} min : p95 entre ${seconds(row.min_p95)} et ${seconds(row.max_p95)} s`,
      evidence: row.ids,
    }));
  },
};
