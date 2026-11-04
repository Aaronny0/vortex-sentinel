import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { responses: 30, windowMinutes: 5 };

/**
 * R14 — Exploration de l'API : au moins 30 réponses introuvables (404) ou rejetées (400, 413, 422) pour une même adresse
 * en 5 min. Un utilisateur se trompe quelques fois ; un outil qui cherche des routes ou des failles enchaîne les refus.
 * Les événements viennent de l'émetteur de Vortex, qui connaît la vraie adresse du navigateur (derrière Traefik, celle
 * du journal Nginx est celle du proxy).
 */
export const r14ApiProbing: Rule = {
  id: 'R14',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ ip: string; responses: number; not_found: number; ids: string[] }>(
      `SELECT host(ip) AS ip, count(*)::int AS responses, count(*) FILTER (WHERE http_status = 404)::int AS not_found,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type IN ('http.access', 'request.rejected') AND http_status IN (400, 404, 413, 422) AND ip IS NOT NULL
         AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY ip
       HAVING count(*) >= $3
       ORDER BY ip`,
      [at, thresholds.windowMinutes, thresholds.responses],
    );
    return rows.map((row) => ({
      key: row.ip,
      severity: 'medium',
      summary: `${count(row.responses, 'requête refusée ou introuvable', 'requêtes refusées ou introuvables')} depuis ${row.ip} en ${thresholds.windowMinutes} min (dont ${row.not_found} introuvables)`,
      evidence: row.ids,
    }));
  },
};
