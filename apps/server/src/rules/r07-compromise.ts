import { account, count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = {
  /** Seuils de R05 et R06, appliqués aux refus qui précèdent la connexion réussie. */
  accountFailures: 10,
  ipFailures: 20,
  ipAccounts: 5,
  burstMinutes: 10,
  /** Délai maximal entre l'attaque et la connexion réussie. */
  followMinutes: 30,
  /** Une connexion réussie reste examinée pendant cette durée (fenêtre d'évaluation). */
  windowMinutes: 10,
};

/**
 * R07 — Compromission probable : une connexion réussit sur un compte visé, dans les 30 min, par une force brute (R05) ou
 * un bourrage d'identifiants (R06). Règle de séquence : elle relie des refus à une réussite, ce qu'aucun seuil seul ne voit.
 * Les conditions de R05 et R06 sont recalculées ici sur les événements, pour que la règle reste rejouable sans dépendre
 * des alertes déjà ouvertes. « Avant » : reçu avant, ou reçu dans le même lot (même `received_at`) et survenu avant, car
 * l'émetteur regroupe les événements de quelques secondes ; l'ordre dans un lot vient de l'horloge de Vortex.
 */
export const r07Compromise: Rule = {
  id: 'R07',
  version: 2,
  kind: 'sequence',
  severity: 'critical',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ id: string; email_hash: string; failures: number; failure_ids: string[] | null; brute_force: boolean; stuffing_ip: string | null }>(
      `WITH fails AS (
         SELECT id, received_at, occurred_at, email_hash, ip FROM sentinel.event
         WHERE type = 'auth.login' AND outcome = 'failure'
           AND received_at > $1::timestamptz - make_interval(mins => $2::int + $3::int + $4::int) AND received_at <= $1
       ),
       bursts AS (
         SELECT f.received_at, f.occurred_at, f.email_hash, f.ip, a.n AS account_failures, i.n AS ip_failures, i.accounts AS ip_accounts
         FROM fails f
         CROSS JOIN LATERAL (
           SELECT count(*) AS n FROM fails g
           WHERE g.email_hash = f.email_hash AND g.received_at > f.received_at - make_interval(mins => $2) AND g.received_at <= f.received_at
         ) a
         CROSS JOIN LATERAL (
           SELECT count(*) AS n, count(DISTINCT g.email_hash) AS accounts FROM fails g
           WHERE g.ip = f.ip AND g.received_at > f.received_at - make_interval(mins => $2) AND g.received_at <= f.received_at
         ) i
       ),
       successes AS (
         SELECT id, received_at, occurred_at, email_hash FROM sentinel.event
         WHERE type = 'auth.login' AND outcome = 'success' AND email_hash IS NOT NULL
           AND received_at > $1::timestamptz - make_interval(mins => $4) AND received_at <= $1
       )
       SELECT s.id, s.email_hash,
         (SELECT count(*)::int FROM fails f
          WHERE f.email_hash = s.email_hash AND f.received_at >= s.received_at - make_interval(mins => $3) AND (f.received_at, f.occurred_at) < (s.received_at, s.occurred_at)) AS failures,
         (SELECT (array_agg(f.id ORDER BY f.received_at, f.id))[1:99] FROM fails f
          WHERE f.email_hash = s.email_hash AND f.received_at >= s.received_at - make_interval(mins => $3) AND (f.received_at, f.occurred_at) < (s.received_at, s.occurred_at)) AS failure_ids,
         EXISTS (
           SELECT 1 FROM bursts b
           WHERE b.email_hash = s.email_hash AND b.account_failures >= $5
             AND b.received_at >= s.received_at - make_interval(mins => $3) AND (b.received_at, b.occurred_at) < (s.received_at, s.occurred_at)
         ) AS brute_force,
         (SELECT host(b.ip) FROM bursts b
          JOIN fails f ON f.ip = b.ip AND f.email_hash = s.email_hash
            AND f.received_at >= s.received_at - make_interval(mins => $3) AND (f.received_at, f.occurred_at) < (s.received_at, s.occurred_at)
          WHERE b.ip_failures >= $6 AND b.ip_accounts >= $7
            AND b.received_at >= s.received_at - make_interval(mins => $3) AND (b.received_at, b.occurred_at) < (s.received_at, s.occurred_at)
          ORDER BY b.received_at LIMIT 1) AS stuffing_ip
       FROM successes s
       ORDER BY s.received_at, s.id`,
      [at, thresholds.burstMinutes, thresholds.followMinutes, thresholds.windowMinutes, thresholds.accountFailures, thresholds.ipFailures, thresholds.ipAccounts],
    );
    const findings = new Map<string, { key: string; severity: 'critical'; summary: string; evidence: string[] }>();
    for (const row of rows) {
      if (!row.brute_force && !row.stuffing_ip) continue;
      const cause = row.brute_force ? 'force brute' : `bourrage d'identifiants depuis ${row.stuffing_ip}`;
      // Plusieurs connexions réussies sur le même compte : un seul constat, sur la première.
      if (!findings.has(row.email_hash))
        findings.set(row.email_hash, {
          key: row.email_hash,
          severity: 'critical',
          summary: `Connexion réussie sur le ${account(row.email_hash)} après ${count(row.failures, 'refus', 'refus')} (${cause})`,
          evidence: [row.id, ...(row.failure_ids ?? [])],
        });
    }
    return [...findings.values()];
  },
};
