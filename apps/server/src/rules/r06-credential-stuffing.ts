import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { failures: 20, accounts: 5, windowMinutes: 10 };

/**
 * R06 — Bourrage d'identifiants : une même adresse IP essaie de nombreux comptes (au moins 20 refus sur au moins 5 comptes
 * en 10 min). Typique d'une liste d'identifiants volés essayée en série.
 */
export const r06CredentialStuffing: Rule = {
  id: 'R06',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ ip: string; failures: number; accounts: number; ids: string[] }>(
      `SELECT host(ip) AS ip, count(*)::int AS failures, count(DISTINCT email_hash)::int AS accounts,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'auth.login' AND outcome = 'failure' AND ip IS NOT NULL
         AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY ip
       HAVING count(*) >= $3 AND count(DISTINCT email_hash) >= $4
       ORDER BY ip`,
      [at, thresholds.windowMinutes, thresholds.failures, thresholds.accounts],
    );
    return rows.map((row) => ({
      key: row.ip,
      severity: 'high',
      summary: `${count(row.failures, 'connexion refusée', 'connexions refusées')} depuis ${row.ip} sur ${count(row.accounts, 'compte')} en ${thresholds.windowMinutes} min`,
      evidence: row.ids,
    }));
  },
};
