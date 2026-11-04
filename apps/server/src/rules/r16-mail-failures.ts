import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { failures: 3, windowMinutes: 15 };

/** R16 — Emails en échec : au moins 3 en 15 min. Les utilisateurs ne reçoivent plus leurs liens de connexion ni leurs codes. */
export const r16MailFailures: Rule = {
  id: 'R16',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ source: string; failures: number; kinds: string; ids: string[] }>(
      `SELECT source, count(*)::int AS failures,
              string_agg(DISTINCT coalesce(body->'attributes'->>'kind', 'inconnu'), ', ' ORDER BY coalesce(body->'attributes'->>'kind', 'inconnu')) AS kinds,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'mail.failed' AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY source
       HAVING count(*) >= $3
       ORDER BY source`,
      [at, thresholds.windowMinutes, thresholds.failures],
    );
    return rows.map((row) => ({
      key: row.source,
      severity: 'high',
      summary: `${count(row.failures, 'email non envoyé', 'emails non envoyés')} en ${thresholds.windowMinutes} min (${row.kinds})`,
      evidence: row.ids,
    }));
  },
};
