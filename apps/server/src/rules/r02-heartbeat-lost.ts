import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { silenceSeconds: 2 * 60, lookbackHours: 24 };

/**
 * R02 — Collecte interrompue : un émetteur ne donne plus de battement de cœur alors que la sonde de santé répond. Vortex
 * fonctionne, mais Sentinel ne voit plus ce qui s'y passe. Seul un émetteur entendu dans les dernières 24 h est attendu :
 * un émetteur jamais déployé ou retiré depuis longtemps ne déclenche rien.
 */
export const r02HeartbeatLost: Rule = {
  id: 'R02',
  version: 1,
  kind: 'state',
  severity: 'high',
  // Les battements arrivent par lots de l'émetteur : on laisse aux lots en retard le temps d'arriver.
  graceMs: MINUTE_MS,
  quietMs: 2 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ source: string; beat_id: string; probe_id: string; silent_seconds: number }>(
      `WITH last_beat AS (
         SELECT DISTINCT ON (source) source, id, received_at
         FROM sentinel.event
         WHERE type = 'emitter.heartbeat' AND received_at > $1::timestamptz - make_interval(hours => $3) AND received_at <= $1
         ORDER BY source, received_at DESC, id DESC
       ),
       probe_ok AS (
         SELECT id FROM sentinel.event
         WHERE type = 'probe.check' AND outcome = 'success'
           AND received_at > $1::timestamptz - make_interval(secs => $2) AND received_at <= $1
         ORDER BY received_at DESC, id DESC
         LIMIT 1
       )
       SELECT b.source, b.id AS beat_id, p.id AS probe_id,
              floor(extract(epoch FROM $1::timestamptz - b.received_at))::int AS silent_seconds
       FROM last_beat b CROSS JOIN probe_ok p
       WHERE b.received_at <= $1::timestamptz - make_interval(secs => $2)
       ORDER BY b.source`,
      [at, thresholds.silenceSeconds, thresholds.lookbackHours],
    );
    return rows.map((row) => ({
      key: row.source,
      severity: 'high',
      summary: `Aucun battement de cœur de ${row.source} depuis ${Math.floor(row.silent_seconds / 60)} min alors que la sonde répond`,
      evidence: [row.beat_id, row.probe_id],
    }));
  },
};
