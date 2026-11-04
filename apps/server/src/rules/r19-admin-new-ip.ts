import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { historyDays: 30, sessionHours: 12, windowMinutes: 10 };

/**
 * R19 — Administration depuis une adresse inhabituelle : action d'un administrateur de la plateforme (`admin.action`,
 * `access.status_changed`) depuis une IP jamais vue pour lui en 30 jours, ni dans ses connexions ni dans ses actions.
 * L'historique s'arrête 12 h avant l'action (durée maximale d'une session d'administration dans Vortex) : la connexion
 * qui a ouvert la session suspecte ne rend pas son adresse « connue ». Un administrateur sans aucun historique ne
 * déclenche pas. L'administrateur est identifié par l'empreinte de son adresse, comme les comptes de R05, R07 et R09.
 */
export const r19AdminNewIp: Rule = {
  id: 'R19',
  version: 1,
  kind: 'sequence',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ email_hash: string; id: string; action: string; ip: string }>(
      `WITH actions AS (
         SELECT id, received_at, email_hash, ip, coalesce(body->'attributes'->>'action', 'décision d''accès') AS action
         FROM sentinel.event
         WHERE type IN ('admin.action', 'access.status_changed') AND email_hash IS NOT NULL AND ip IS NOT NULL
           AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       ),
       history AS (
         SELECT a.id AS action_id, h.ip
         FROM actions a
         JOIN sentinel.event h
           ON h.email_hash = a.email_hash AND h.ip IS NOT NULL
          AND (h.type IN ('admin.action', 'access.status_changed') OR (h.type = 'auth.login' AND h.outcome = 'success'))
          AND h.received_at >= a.received_at - make_interval(days => $3)
          AND h.received_at < a.received_at - make_interval(hours => $4)
       )
       SELECT a.email_hash, a.id, a.action, host(a.ip) AS ip
       FROM actions a
       WHERE EXISTS (SELECT 1 FROM history h WHERE h.action_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM history h WHERE h.action_id = a.id AND h.ip = a.ip)
       ORDER BY a.received_at, a.id`,
      [at, thresholds.windowMinutes, thresholds.historyDays, thresholds.sessionHours],
    );
    const findings = new Map<string, { key: string; severity: 'high'; summary: string; evidence: string[] }>();
    for (const row of rows) {
      const finding = findings.get(row.email_hash);
      if (finding) {
        if (finding.evidence.length < 100) finding.evidence.push(row.id);
        continue;
      }
      findings.set(row.email_hash, {
        key: row.email_hash,
        severity: 'high',
        summary: `${row.action} par l'administrateur ${row.email_hash.slice(0, 8)} depuis une adresse jamais vue en ${thresholds.historyDays} jours (${row.ip})`,
        evidence: [row.id],
      });
    }
    return [...findings.values()];
  },
};
