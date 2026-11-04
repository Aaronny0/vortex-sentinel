import type { PoolClient } from 'pg';
import { severities, type Severity } from '../rules/types.ts';

/** Gravités qui ouvrent un incident (docs/conception.md § 7.2) ; une alerte faible ou info reste une alerte. */
export const INCIDENT_SEVERITIES: readonly Severity[] = ['medium', 'high', 'critical'];
export const ACTIVE_STATUSES = ['open', 'acknowledged', 'in_progress'] as const;

const rank = (severity: string) => severities.indexOf(severity as Severity);

type Alert = { id: string; ruleId: string; key: string; severity: Severity; summary: string };

/**
 * Rattache une alerte à l'incident actif de même clé, ou en ouvre un ; porte la gravité de l'incident au plus haut de ses
 * alertes. Appelé par le moteur dans la transaction de l'alerte : alerte et incident sont écrits ensemble ou pas du tout.
 * Deux règles qui constatent en même temps la même clé (R05 et R07 sur un compte) ne créent qu'un incident : l'index
 * unique sur les incidents actifs fait attendre la seconde, qui rejoint alors le premier.
 */
export async function linkAlertToIncident(client: PoolClient, alert: Alert, at: Date): Promise<{ incidentId: string; opened: boolean } | null> {
  if (!INCIDENT_SEVERITIES.includes(alert.severity)) return null;
  const history = (incidentId: string, kind: string, comment: string) =>
    client.query('INSERT INTO sentinel.incident_history (incident_id, at, kind, comment) VALUES ($1, $2, $3, $4)', [incidentId, at, kind, comment]);
  const raise = async (incidentId: string, current: string) => {
    if (rank(alert.severity) <= rank(current)) return;
    await client.query('UPDATE sentinel.incident SET severity = $2, updated_at = $3 WHERE id = $1', [incidentId, alert.severity, at]);
    await history(incidentId, 'severity_raised', `Gravité portée à ${alert.severity} par ${alert.ruleId} : ${alert.summary}`);
  };

  // Déjà rattachée (alerte qui dure ou s'aggrave) : seule la gravité de son incident peut évoluer, s'il est encore actif.
  const { rows: linked } = await client.query<{ id: string; severity: string; status: string }>(
    `SELECT i.id, i.severity, i.status FROM sentinel.incident_alert ia JOIN sentinel.incident i ON i.id = ia.incident_id
     WHERE ia.alert_id = $1 FOR UPDATE OF i`,
    [alert.id],
  );
  if (linked[0]) {
    if ((ACTIVE_STATUSES as readonly string[]).includes(linked[0].status)) await raise(linked[0].id, linked[0].severity);
    return { incidentId: linked[0].id, opened: false };
  }

  const { rows: created } = await client.query<{ id: string }>(
    `INSERT INTO sentinel.incident (key, title, severity, opened_at, updated_at) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (key) WHERE status IN ('open', 'acknowledged', 'in_progress') DO NOTHING
     RETURNING id`,
    [alert.key, `${alert.ruleId} · ${alert.summary}`.slice(0, 500), alert.severity, at],
  );
  let incidentId = created[0]?.id;
  const opened = !!incidentId;
  if (incidentId) await history(incidentId, 'opened', `Ouvert par ${alert.ruleId} : ${alert.summary}`);
  else {
    const { rows } = await client.query<{ id: string; severity: string }>(
      `SELECT id, severity FROM sentinel.incident WHERE key = $1 AND status IN ('open', 'acknowledged', 'in_progress') FOR UPDATE`,
      [alert.key],
    );
    incidentId = rows[0]!.id;
    await raise(incidentId, rows[0]!.severity);
  }
  await client.query('INSERT INTO sentinel.incident_alert (incident_id, alert_id, linked_at) VALUES ($1, $2, $3)', [incidentId, alert.id, at]);
  if (!opened) await history(incidentId, 'alert_linked', `Alerte ${alert.ruleId} rattachée : ${alert.summary}`);
  return { incidentId, opened };
}

/**
 * Résolution automatique (disponibilité rétablie) : un incident encore « ouvert », dont toutes les alertes sont closes et
 * viennent de règles de disponibilité, est résolu par le système. Un incident pris en charge par un opérateur, ou qui
 * contient une alerte de sécurité, attend toujours une décision humaine.
 */
export async function autoResolveIncidents(client: PoolClient, ruleId: string, at: Date): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE sentinel.incident i SET status = 'resolved', resolved_at = $2, updated_at = $2
     WHERE i.status = 'open'
       AND i.id IN (SELECT ia.incident_id FROM sentinel.incident_alert ia JOIN sentinel.alert a ON a.id = ia.alert_id
                    WHERE a.rule_id = $1 AND a.status = 'closed')
       AND NOT EXISTS (SELECT 1 FROM sentinel.incident_alert ia JOIN sentinel.alert a ON a.id = ia.alert_id
                       WHERE ia.incident_id = i.id AND (a.status = 'open' OR NOT a.auto_resolve))
     RETURNING i.id`,
    [ruleId, at],
  );
  for (const row of rows)
    await client.query(
      `INSERT INTO sentinel.incident_history (incident_id, at, kind, from_status, to_status, comment)
       VALUES ($1, $2, 'transition', 'open', 'resolved', 'Résolution automatique : service rétabli, toutes les alertes sont closes.')`,
      [row.id, at],
    );
  return rows.length;
}
