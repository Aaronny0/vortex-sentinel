import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { actions: 5, windowMinutes: 10 };

/** Actions d'administration qui coupent l'accès ou changent ce que paient les entreprises. */
export const sensitiveAdminActions = ['subscription.suspend', 'subscription.payment_cancel', 'subscription.tariff', 'finance.default_amount'] as const;

/**
 * R20 — Rafale d'actions d'administration sensibles : au moins 5 en 10 min par un même administrateur (suspensions,
 * annulations de paiement, tarifs, montant par défaut, accès suspendus ou refusés). Un compte d'administration
 * compromis ou une erreur de manipulation touche alors plusieurs entreprises à la fois.
 */
export const r20AdminBurst: Rule = {
  id: 'R20',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ email_hash: string; actions: number; organizations: number; ids: string[] }>(
      `SELECT email_hash, count(*)::int AS actions, count(DISTINCT organization_id)::int AS organizations,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE email_hash IS NOT NULL
         AND ((type = 'admin.action' AND body->'attributes'->>'action' = ANY($4::text[]))
           OR (type = 'access.status_changed' AND body->'attributes'->>'status' IN ('SUSPENDED', 'REJECTED')))
         AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY email_hash
       HAVING count(*) >= $3
       ORDER BY email_hash`,
      [at, thresholds.windowMinutes, thresholds.actions, sensitiveAdminActions],
    );
    return rows.map((row) => ({
      key: row.email_hash,
      severity: 'high',
      summary: `${count(row.actions, 'action sensible', 'actions sensibles')} de l'administrateur ${row.email_hash.slice(0, 8)} en ${thresholds.windowMinutes} min (${count(row.organizations, 'entreprise')})`,
      evidence: row.ids,
    }));
  },
};
