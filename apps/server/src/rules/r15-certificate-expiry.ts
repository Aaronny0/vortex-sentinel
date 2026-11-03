import { DAY_MS, MINUTE_MS, type Rule } from './types.ts';

const thresholds = { warningDays: 14, criticalDays: 3, lookbackHours: 48 };

/**
 * R15 — Certificat TLS bientôt expiré. Les jours restants sont recalculés à l'instant évalué depuis la date d'expiration
 * lue par la sonde (quotidienne) : l'alerte passe en critique à 3 jours sans attendre la mesure suivante.
 */
export const r15CertificateExpiry: Rule = {
  id: 'R15',
  version: 1,
  kind: 'state',
  severity: 'medium',
  graceMs: 0,
  quietMs: 2 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ id: string; target: string; valid_to: string }>(
      `SELECT DISTINCT ON (target) id, target, valid_to
       FROM (
         SELECT id, received_at, body->'attributes'->>'target' AS target, body->'attributes'->>'validTo' AS valid_to
         FROM sentinel.event
         WHERE type = 'tls.certificate' AND received_at > $1::timestamptz - make_interval(hours => $2) AND received_at <= $1
       ) latest
       WHERE target IS NOT NULL
       ORDER BY target, received_at DESC, id DESC`,
      [at, thresholds.lookbackHours],
    );
    return rows.flatMap((row) => {
      // Dernière mesure sans date (hôte injoignable) : rien à dire sur l'expiration.
      const validTo = row.valid_to ? new Date(row.valid_to) : undefined;
      if (!validTo || Number.isNaN(validTo.getTime())) return [];
      const daysLeft = Math.floor((validTo.getTime() - at.getTime()) / DAY_MS);
      if (daysLeft >= thresholds.warningDays) return [];
      return [
        {
          key: row.target,
          severity: daysLeft < thresholds.criticalDays ? 'critical' : 'medium',
          summary:
            daysLeft < 0
              ? `Le certificat de ${row.target} a expiré le ${validTo.toISOString().slice(0, 10)}`
              : `Le certificat de ${row.target} expire dans ${daysLeft} jour${daysLeft > 1 ? 's' : ''} (${validTo.toISOString().slice(0, 10)})`,
          evidence: [row.id],
        },
      ];
    });
  },
};
