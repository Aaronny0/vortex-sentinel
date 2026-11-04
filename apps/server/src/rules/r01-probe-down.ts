import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { consecutiveFailures: 3, lookbackSeconds: 10 * 60 };

/**
 * R01 — Service indisponible : les 3 derniers contrôles d'une cible ont échoué. Un échec isolé (réseau lent, redémarrage)
 * ne suffit pas, ce qui évite les fausses alertes qui finissent par faire ignorer les vraies.
 */
export const r01ProbeDown: Rule = {
  id: 'R01',
  version: 1,
  kind: 'state',
  autoResolve: true,
  severity: 'critical',
  graceMs: 0,
  quietMs: 2 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ target: string; ids: string[]; last_code: string | null }>(
      `WITH recent AS (
         SELECT id, outcome, received_at, body->'attributes'->>'target' AS target, body->'attributes'->>'code' AS code,
                row_number() OVER (PARTITION BY body->'attributes'->>'target' ORDER BY received_at DESC, id DESC) AS rank
         FROM sentinel.event
         WHERE type = 'probe.check' AND received_at > $1::timestamptz - make_interval(secs => $2) AND received_at <= $1
       )
       SELECT target, array_agg(id ORDER BY received_at, id) AS ids,
              (array_agg(code ORDER BY received_at DESC, id DESC))[1] AS last_code
       FROM recent
       WHERE rank <= $3 AND target IS NOT NULL
       GROUP BY target
       HAVING count(*) = $3 AND bool_and(outcome = 'failure')
       ORDER BY target`,
      [at, thresholds.lookbackSeconds, thresholds.consecutiveFailures],
    );
    return rows.map((row) => ({
      key: row.target,
      severity: 'critical',
      summary: `${thresholds.consecutiveFailures} échecs consécutifs de la sonde ${row.target}${row.last_code ? ` (dernier : ${row.last_code})` : ''}`,
      evidence: row.ids,
    }));
  },
};
