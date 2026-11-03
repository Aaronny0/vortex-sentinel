import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { warningPercent: 15, criticalPercent: 5, lookbackMinutes: 15 };

/** R17 — Espace disque insuffisant : sous 15 % libre, PostgreSQL et les journaux risquent de s'arrêter ; sous 5 %, critique. */
export const r17DiskSpace: Rule = {
  id: 'R17',
  version: 1,
  kind: 'state',
  severity: 'high',
  graceMs: 0,
  quietMs: 2 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ id: string; path: string; free_percent: number }>(
      `SELECT DISTINCT ON (path) id, path, free_percent
       FROM (
         SELECT id, received_at, body->'attributes'->>'path' AS path, (body->'attributes'->>'freePercent')::float8 AS free_percent
         FROM sentinel.event
         WHERE type = 'host.disk' AND outcome = 'success'
           AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       ) latest
       WHERE path IS NOT NULL AND free_percent IS NOT NULL
       ORDER BY path, received_at DESC, id DESC`,
      [at, thresholds.lookbackMinutes],
    );
    return rows
      .filter((row) => row.free_percent < thresholds.warningPercent)
      .map((row) => ({
        key: row.path,
        severity: row.free_percent < thresholds.criticalPercent ? 'critical' : 'high',
        summary: `Espace disque libre sur ${row.path} : ${String(row.free_percent).replace('.', ',')} %`,
        evidence: [row.id],
      }));
  },
};
