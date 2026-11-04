import { account } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { historyDays: 30, followMinutes: 60, windowMinutes: 10 };

/**
 * R09 — Changement sensible depuis une adresse inhabituelle : connexion réussie depuis une IP jamais vue pour ce compte
 * en 30 jours, suivie dans l'heure d'un changement d'équipe (`team.update`) ou de réglages (`settings.save`). Un compte
 * sans aucune connexion dans les 30 jours n'a pas d'habitudes : il ne déclenche pas (nouveau compte). Le compte est relié
 * de la connexion à l'opération par l'empreinte de son adresse.
 */
export const r09NewIpPrivilegeChange: Rule = {
  id: 'R09',
  version: 2,
  kind: 'sequence',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ email_hash: string; change_id: string; change_type: string; login_id: string; ip: string }>(
      `WITH changes AS (
         SELECT id, received_at, occurred_at, email_hash, type FROM sentinel.event
         WHERE type IN ('team.update', 'settings.save') AND email_hash IS NOT NULL
           AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       )
       SELECT c.email_hash, c.id AS change_id, c.type AS change_type, l.id AS login_id, host(l.ip) AS ip
       FROM changes c
       JOIN sentinel.event l
         ON l.type = 'auth.login' AND l.outcome = 'success' AND l.ip IS NOT NULL AND l.email_hash = c.email_hash
        AND (l.received_at, l.occurred_at) <= (c.received_at, c.occurred_at) AND l.received_at >= c.received_at - make_interval(mins => $3)
       WHERE EXISTS (
           SELECT 1 FROM sentinel.event p
           WHERE p.type = 'auth.login' AND p.outcome = 'success' AND p.email_hash = l.email_hash
             AND (p.received_at, p.occurred_at) < (l.received_at, l.occurred_at) AND p.received_at >= l.received_at - make_interval(days => $4)
         )
         AND NOT EXISTS (
           SELECT 1 FROM sentinel.event p
           WHERE p.type = 'auth.login' AND p.outcome = 'success' AND p.email_hash = l.email_hash AND p.ip = l.ip
             AND (p.received_at, p.occurred_at) < (l.received_at, l.occurred_at) AND p.received_at >= l.received_at - make_interval(days => $4)
         )
       ORDER BY c.received_at, c.id, l.received_at DESC`,
      [at, thresholds.windowMinutes, thresholds.followMinutes, thresholds.historyDays],
    );
    const findings = new Map<string, { key: string; severity: 'high'; summary: string; evidence: string[] }>();
    for (const row of rows)
      if (!findings.has(row.email_hash))
        findings.set(row.email_hash, {
          key: row.email_hash,
          severity: 'high',
          summary: `${row.change_type} par le ${account(row.email_hash)} moins d'une heure après une connexion depuis une adresse jamais vue (${row.ip})`,
          evidence: [row.login_id, row.change_id],
        });
    return [...findings.values()];
  },
};
