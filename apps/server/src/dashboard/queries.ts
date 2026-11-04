import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../common/clock.ts';
import { AppError } from '../common/errors.ts';
import { parse } from '../operators/service.ts';
import { rules } from '../rules/registry.ts';
import { DAY_MS } from '../rules/types.ts';
import { incidentStatuses } from '../incidents/transitions.ts';

/**
 * Lectures du tableau de bord. Toutes bornées (limite, période) et paramétrées. Les dates sortent en ISO, les compteurs
 * en nombres. L'Observateur reçoit des textes expurgés (voir `redactForObserver`).
 */

const SEVERITY_ORDER = "array_position(ARRAY['info','low','medium','high','critical'], severity)";

/** Masque adresses IP et empreintes de comptes dans un texte, pour l'Observateur (docs/conception.md § 8.1). */
export function redactForObserver(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '•••')
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi, '•••')
    .replace(/\bcompte [0-9a-f]{8}\b/g, 'compte •••');
}

const HOUR_MS = DAY_MS / 24;

const listSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true, error: 'Date invalide.' }).optional(),
});

export async function overview(pool: Pool, clock: Clock) {
  const now = clock.now();
  const [probes, heartbeats, certificates, disks, incidents, alerts, engine, volume, errors] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (target) body->'attributes'->>'target' AS target, outcome, http_status AS status,
              coalesce((body->'http'->>'durationMs')::int, (body->'attributes'->>'durationMs')::int) AS "durationMs",
              body->'attributes'->>'code' AS code, received_at AS "checkedAt"
       FROM sentinel.event WHERE type = 'probe.check' AND received_at > $1::timestamptz - interval '1 day'
       ORDER BY target, received_at DESC, id DESC`,
      [now],
    ),
    pool.query(
      `SELECT DISTINCT ON (source) source, received_at AS "receivedAt",
              (body->'attributes'->>'pending')::int AS pending, (body->'attributes'->>'droppedOverflow')::int AS "droppedOverflow",
              (body->'attributes'->>'rejected')::int AS rejected
       FROM sentinel.event WHERE type = 'emitter.heartbeat' AND received_at > $1::timestamptz - interval '1 day'
       ORDER BY source, received_at DESC, id DESC`,
      [now],
    ),
    pool.query(
      `SELECT DISTINCT ON (target) body->'attributes'->>'target' AS target, outcome, body->'attributes'->>'validTo' AS "validTo",
              body->'attributes'->>'code' AS code, received_at AS "checkedAt"
       FROM sentinel.event WHERE type = 'tls.certificate' AND received_at > $1::timestamptz - interval '3 days'
       ORDER BY target, received_at DESC, id DESC`,
      [now],
    ),
    pool.query(
      `SELECT DISTINCT ON (path) body->'attributes'->>'path' AS path, (body->'attributes'->>'freePercent')::float8 AS "freePercent",
              (body->'attributes'->>'freeBytes')::float8 AS "freeBytes", received_at AS "checkedAt"
       FROM sentinel.event WHERE type = 'host.disk' AND outcome = 'success' AND received_at > $1::timestamptz - interval '1 hour'
       ORDER BY path, received_at DESC, id DESC`,
      [now],
    ),
    pool.query(`SELECT severity, count(*)::int AS n FROM sentinel.incident WHERE status IN ('open', 'acknowledged', 'in_progress') GROUP BY severity`),
    pool.query(`SELECT severity, count(*)::int AS n FROM sentinel.alert WHERE status = 'open' GROUP BY severity`),
    pool.query(`SELECT min(evaluated_to) AS "oldestCheckpoint", max(updated_at) AS "lastCycle" FROM sentinel.rule_checkpoint`),
    pool.query(
      `SELECT category, count(*)::int AS n FROM sentinel.event WHERE received_at > $1::timestamptz - interval '1 day' GROUP BY category`,
      [now],
    ),
    // Évolution des erreurs : 24 tranches d'une heure, la dernière se termine maintenant.
    pool.query(
      `SELECT least(floor(extract(epoch FROM received_at - ($1::timestamptz - interval '1 day')) / 3600)::int, 23) AS bucket,
              count(*) FILTER (WHERE type = 'app.error')::int AS server, count(*) FILTER (WHERE type = 'ui.error')::int AS interface
       FROM sentinel.event WHERE type IN ('app.error', 'ui.error') AND received_at > $1::timestamptz - interval '1 day' AND received_at <= $1
       GROUP BY 1`,
      [now],
    ),
  ]);
  const bySeverity = (rows: { severity: string; n: number }[]) => Object.fromEntries(rows.map((row) => [row.severity, row.n]));
  return {
    generatedAt: now.toISOString(),
    probes: probes.rows,
    emitters: heartbeats.rows,
    certificates: certificates.rows.map((row) => ({
      ...row,
      daysLeft: row.validTo ? Math.floor((Date.parse(row.validTo) - now.getTime()) / DAY_MS) : null,
    })),
    disks: disks.rows,
    activeIncidents: bySeverity(incidents.rows),
    openAlerts: bySeverity(alerts.rows),
    engine: engine.rows[0],
    eventsLast24h: Object.fromEntries(volume.rows.map((row) => [row.category, row.n])),
    errorsLast24h: Array.from({ length: 24 }, (_, index) => {
      const bucket = errors.rows.find((row) => row.bucket === index);
      const start = now.getTime() - DAY_MS + index * HOUR_MS;
      return { start: new Date(start).toISOString(), end: new Date(start + HOUR_MS).toISOString(), server: bucket?.server ?? 0, interface: bucket?.interface ?? 0 };
    }),
  };
}

const incidentListSchema = listSchema.extend({
  status: z.enum(['active', 'all', ...incidentStatuses], { error: 'Statut inconnu.' }).default('active'),
  severity: z.enum(['medium', 'high', 'critical'], { error: 'Gravité inconnue.' }).optional(),
});

export async function listIncidents(pool: Pool, query: unknown) {
  const { status, severity, limit, before } = parse(incidentListSchema, query);
  const statuses = status === 'active' ? ['open', 'acknowledged', 'in_progress'] : status === 'all' ? [...incidentStatuses] : [status];
  const { rows } = await pool.query(
    `SELECT i.id, i.number::int AS number, i.title, i.severity, i.status, i.opened_at AS "openedAt", i.updated_at AS "updatedAt",
            i.resolved_at AS "resolvedAt", o.name AS assignee,
            (SELECT count(*)::int FROM sentinel.incident_alert ia WHERE ia.incident_id = i.id) AS alerts
     FROM sentinel.incident i LEFT JOIN sentinel.operator o ON o.id = i.assignee_id
     WHERE i.status = ANY($1) AND ($2::timestamptz IS NULL OR i.opened_at < $2) AND ($4::text IS NULL OR i.severity = $4)
     ORDER BY CASE WHEN i.status IN ('open','acknowledged','in_progress') THEN 0 ELSE 1 END,
              ${SEVERITY_ORDER.replace('severity', 'i.severity')} DESC, i.opened_at DESC
     LIMIT $3`,
    [statuses, before ?? null, limit, severity ?? null],
  );
  return rows;
}

export async function getIncident(pool: Pool, id: string) {
  parse(z.uuid({ error: 'Incident : identifiant invalide.' }), id);
  const [incident, alerts, history] = await Promise.all([
    pool.query(
      `SELECT i.id, i.number::int AS number, i.key, i.title, i.severity, i.status, i.opened_at AS "openedAt",
              i.updated_at AS "updatedAt", i.resolved_at AS "resolvedAt", i.closed_at AS "closedAt",
              i.assignee_id AS "assigneeId", o.name AS assignee
       FROM sentinel.incident i LEFT JOIN sentinel.operator o ON o.id = i.assignee_id WHERE i.id = $1`,
      [id],
    ),
    pool.query(
      `SELECT a.id, a.rule_id AS "ruleId", a.rule_version AS "ruleVersion", a.severity, a.status, a.summary, a.hits,
              a.first_seen_at AS "firstSeenAt", a.last_seen_at AS "lastSeenAt", a.closed_at AS "closedAt",
              cardinality(a.evidence)::int AS "evidenceCount"
       FROM sentinel.incident_alert ia JOIN sentinel.alert a ON a.id = ia.alert_id
       WHERE ia.incident_id = $1 ORDER BY a.first_seen_at`,
      [id],
    ),
    pool.query(
      `SELECT h.id::int AS id, h.at, h.kind, h.from_status AS "fromStatus", h.to_status AS "toStatus", h.comment, o.name AS actor
       FROM sentinel.incident_history h LEFT JOIN sentinel.operator o ON o.id = h.actor_id
       WHERE h.incident_id = $1 ORDER BY h.at, h.id`,
      [id],
    ),
  ]);
  if (!incident.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Incident introuvable.');
  return { ...incident.rows[0], alerts: alerts.rows, history: history.rows };
}

const alertListSchema = listSchema.extend({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  rule: z.string().regex(/^R\d{2}$/, { error: 'Règle inconnue.' }).optional(),
});

export async function listAlerts(pool: Pool, query: unknown) {
  const { status, rule, limit, before } = parse(alertListSchema, query);
  const { rows } = await pool.query(
    `SELECT a.id, a.rule_id AS "ruleId", a.key, a.severity, a.status, a.summary, a.hits, a.first_seen_at AS "firstSeenAt",
            a.last_seen_at AS "lastSeenAt", a.closed_at AS "closedAt", ia.incident_id AS "incidentId", i.number::int AS "incidentNumber"
     FROM sentinel.alert a
     LEFT JOIN sentinel.incident_alert ia ON ia.alert_id = a.id LEFT JOIN sentinel.incident i ON i.id = ia.incident_id
     WHERE ($1 = 'all' OR a.status = $1) AND ($2::text IS NULL OR a.rule_id = $2) AND ($3::timestamptz IS NULL OR a.last_seen_at < $3)
     ORDER BY a.last_seen_at DESC LIMIT $4`,
    [status, rule ?? null, before ?? null, limit],
  );
  return rows;
}

const EVENT_COLUMNS = `id, received_at AS "receivedAt", occurred_at AS "occurredAt", source, category, type, outcome,
  host(ip) AS ip, email_hash AS "emailHash", http_status AS "httpStatus", body`;

/** Une alerte et ses preuves : les événements déclencheurs, dans l'ordre de réception. */
export async function getAlert(pool: Pool, id: string) {
  parse(z.uuid({ error: 'Alerte : identifiant invalide.' }), id);
  const { rows } = await pool.query(
    `SELECT a.id, a.rule_id AS "ruleId", a.rule_version AS "ruleVersion", a.key, a.severity, a.status, a.summary, a.hits,
            a.thresholds, a.first_seen_at AS "firstSeenAt", a.last_seen_at AS "lastSeenAt", a.closed_at AS "closedAt",
            a.evidence::text[] AS evidence, ia.incident_id AS "incidentId"
     FROM sentinel.alert a LEFT JOIN sentinel.incident_alert ia ON ia.alert_id = a.id WHERE a.id = $1`,
    [id],
  );
  const alert = rows[0];
  if (!alert) throw new AppError(404, 'NOT_FOUND', 'Alerte introuvable.');
  // Les preuves datent au plus de la fenêtre de la règle avant le premier constat : la recherche reste bornée.
  const { rows: events } = await pool.query(
    `SELECT ${EVENT_COLUMNS} FROM sentinel.event
     WHERE id = ANY($1::uuid[]) AND received_at >= $2::timestamptz - interval '31 days' AND received_at <= $3
     ORDER BY received_at, id`,
    [alert.evidence, alert.firstSeenAt, alert.lastSeenAt],
  );
  return { ...alert, events };
}

const eventSearchSchema = listSchema.extend({
  type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, { error: 'Type invalide.' }).optional(),
  category: z.enum(['availability', 'technical', 'security', 'business']).optional(),
  outcome: z.enum(['success', 'failure', 'unknown']).optional(),
  ip: z.union([z.ipv4(), z.ipv6()], { error: 'Adresse IP invalide.' }).optional(),
  account: z.string().regex(/^[0-9a-f]{8,64}$/, { error: 'Empreinte de compte invalide.' }).optional(),
  from: z.iso.datetime({ offset: true, error: 'Date invalide.' }).optional(),
});

/** Recherche d'événements, bornée à 31 jours par requête (les partitions mensuelles ne sont lues que si nécessaire). */
export async function searchEvents(pool: Pool, clock: Clock, query: unknown) {
  const filters = parse(eventSearchSchema, query);
  const to = filters.before ? new Date(filters.before) : clock.now();
  const from = filters.from ? new Date(filters.from) : new Date(to.getTime() - DAY_MS);
  if (to.getTime() - from.getTime() > 31 * DAY_MS) throw new AppError(422, 'VALIDATION_FAILED', 'Certains champs sont invalides.', { from: 'Période de 31 jours au plus.' });
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLUMNS} FROM sentinel.event
     WHERE received_at >= $1 AND received_at < $2
       AND ($3::text IS NULL OR type = $3) AND ($4::text IS NULL OR category = $4) AND ($5::text IS NULL OR outcome = $5)
       AND ($6::inet IS NULL OR ip = $6) AND ($7::text IS NULL OR email_hash LIKE $7 || '%')
     ORDER BY received_at DESC, id DESC LIMIT $8`,
    [from, to, filters.type ?? null, filters.category ?? null, filters.outcome ?? null, filters.ip ?? null, filters.account ?? null, filters.limit],
  );
  return { from: from.toISOString(), to: to.toISOString(), events: rows };
}

/** Règles actives, leurs seuils, et leur bilan : alertes, incidents, faux positifs (calibrage, chapitre d'évaluation). */
export async function listRules(pool: Pool) {
  const { rows } = await pool.query<{ rule_id: string; alerts: number; open: number; false_positives: number; last_seen: Date | null }>(
    `SELECT a.rule_id, count(*)::int AS alerts, count(*) FILTER (WHERE a.status = 'open')::int AS open,
            count(DISTINCT i.id) FILTER (WHERE i.status = 'false_positive')::int AS false_positives, max(a.last_seen_at) AS last_seen
     FROM sentinel.alert a LEFT JOIN sentinel.incident_alert ia ON ia.alert_id = a.id LEFT JOIN sentinel.incident i ON i.id = ia.incident_id
     GROUP BY a.rule_id`,
  );
  const stats = new Map(rows.map((row) => [row.rule_id, row]));
  return rules.map((rule) => ({
    id: rule.id,
    version: rule.version,
    kind: rule.kind,
    severity: rule.severity,
    thresholds: rule.thresholds,
    alerts: stats.get(rule.id)?.alerts ?? 0,
    openAlerts: stats.get(rule.id)?.open ?? 0,
    falsePositives: stats.get(rule.id)?.false_positives ?? 0,
    lastSeenAt: stats.get(rule.id)?.last_seen ?? null,
  }));
}

export async function listAudit(pool: Pool, query: unknown) {
  const { limit, before } = parse(listSchema, query);
  const { rows } = await pool.query(
    `SELECT a.id::int AS id, a.at, a.action, a.target_type AS "targetType", a.target_id AS "targetId", host(a.ip) AS ip, a.details, o.name AS operator
     FROM sentinel.operator_audit a LEFT JOIN sentinel.operator o ON o.id = a.operator_id
     WHERE ($1::timestamptz IS NULL OR a.at < $1) ORDER BY a.at DESC, a.id DESC LIMIT $2`,
    [before ?? null, limit],
  );
  return rows;
}

/** Commentaire libre sur un incident, historisé comme le reste. */
export async function commentIncident(pool: Pool, clock: Clock, incidentId: string, actorId: string, input: unknown) {
  parse(z.uuid({ error: 'Incident : identifiant invalide.' }), incidentId);
  const { comment } = parse(z.strictObject({ comment: z.string().trim().min(3, { error: 'Commentaire trop court.' }).max(2000) }), input);
  const { rowCount } = await pool.query(
    `INSERT INTO sentinel.incident_history (incident_id, at, actor_id, kind, comment)
     SELECT id, $2, $3, 'comment', $4 FROM sentinel.incident WHERE id = $1`,
    [incidentId, clock.now(), actorId, comment],
  );
  if (!rowCount) throw new AppError(404, 'NOT_FOUND', 'Incident introuvable.');
}

const availabilitySchema = z.strictObject({ days: z.coerce.number().int().refine((value) => [1, 7, 30].includes(value), { error: 'Période : 1, 7 ou 30 jours.' }).default(1) });

/**
 * Disponibilité par cible de sonde : taux de contrôles réussis, temps de réponse, 24 tranches régulières sur la période,
 * et interruptions (suites d'échecs consécutifs, avec leur début, leur fin et leur durée).
 */
export async function availability(pool: Pool, clock: Clock, query: unknown) {
  const { days } = parse(availabilitySchema, query);
  const to = clock.now();
  const from = new Date(to.getTime() - days * DAY_MS);
  const bucketSeconds = (days * DAY_MS) / 24 / 1000;
  const [summary, buckets, outages] = await Promise.all([
    pool.query(
      `SELECT body->'attributes'->>'target' AS target, count(*)::int AS checks, count(*) FILTER (WHERE outcome = 'failure')::int AS failures,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (body->'http'->>'durationMs')::float8)::int AS "p95Ms",
              avg((body->'http'->>'durationMs')::float8)::int AS "avgMs"
       FROM sentinel.event WHERE type = 'probe.check' AND received_at > $1 AND received_at <= $2
       GROUP BY 1 ORDER BY 1`,
      [from, to],
    ),
    pool.query(
      `SELECT body->'attributes'->>'target' AS target, floor(extract(epoch FROM received_at - $1::timestamptz) / $3)::int AS bucket,
              count(*)::int AS checks, count(*) FILTER (WHERE outcome = 'failure')::int AS failures
       FROM sentinel.event WHERE type = 'probe.check' AND received_at > $1 AND received_at <= $2
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to, bucketSeconds],
    ),
    pool.query(
      `WITH checks AS (
         SELECT body->'attributes'->>'target' AS target, received_at, outcome, body->'attributes'->>'code' AS code,
                row_number() OVER (PARTITION BY body->'attributes'->>'target' ORDER BY received_at, id)
                - row_number() OVER (PARTITION BY body->'attributes'->>'target', outcome ORDER BY received_at, id) AS island
         FROM sentinel.event WHERE type = 'probe.check' AND received_at > $1 AND received_at <= $2
       )
       SELECT target, min(received_at) AS "startedAt", max(received_at) AS "lastFailureAt", count(*)::int AS failures,
              (array_agg(code ORDER BY received_at DESC))[1] AS code
       FROM checks WHERE outcome = 'failure' GROUP BY target, island ORDER BY min(received_at) DESC LIMIT 50`,
      [from, to],
    ),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketMinutes: bucketSeconds / 60,
    targets: summary.rows.map((row) => ({
      ...row,
      availabilityPercent: row.checks ? Math.round(((row.checks - row.failures) / row.checks) * 10000) / 100 : null,
      buckets: Array.from({ length: 24 }, (_, index) => {
        const bucket = buckets.rows.find((item) => item.target === row.target && item.bucket === index);
        return { start: new Date(from.getTime() + index * bucketSeconds * 1000).toISOString(), checks: bucket?.checks ?? 0, failures: bucket?.failures ?? 0 };
      }),
    })),
    outages: outages.rows,
  };
}
