import { account, count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { failures: 10, windowMinutes: 10 };

/** R05 — Force brute sur un compte : au moins 10 connexions refusées sur le même compte en 10 min, d'où qu'elles viennent. */
export const r05AccountBruteForce: Rule = {
  id: 'R05',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ email_hash: string; failures: number; ips: number; ids: string[] }>(
      `SELECT email_hash, count(*)::int AS failures, count(DISTINCT ip)::int AS ips,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'auth.login' AND outcome = 'failure' AND email_hash IS NOT NULL
         AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY email_hash
       HAVING count(*) >= $3
       ORDER BY email_hash`,
      [at, thresholds.windowMinutes, thresholds.failures],
    );
    return rows.map((row) => ({
      key: row.email_hash,
      severity: 'high',
      summary: `${count(row.failures, 'connexion refusée', 'connexions refusées')} sur le ${account(row.email_hash)} en ${thresholds.windowMinutes} min (${count(row.ips, 'adresse IP', 'adresses IP')})`,
      evidence: row.ids,
    }));
  },
};
