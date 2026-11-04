import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { denials: 5, windowMinutes: 10 };

/**
 * R08 — Accès refusés répétés : au moins 5 refus (403) pour un même acteur en 10 min, signe d'une recherche de droits.
 * L'acteur est l'utilisateur quand Vortex le connaît, sinon le compte, sinon l'adresse IP : la capture HTTP de Vortex
 * ne résout pas l'utilisateur d'une requête refusée, l'adresse est alors le meilleur repère.
 */
export const r08AccessDenied: Rule = {
  id: 'R08',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ actor: string; denials: number; routes: number; ids: string[] }>(
      `SELECT coalesce('utilisateur ' || user_id::text, 'compte ' || left(email_hash, 8), 'adresse ' || host(ip)) AS actor,
              count(*)::int AS denials, count(DISTINCT body->'http'->>'route')::int AS routes,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'access.denied' AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
         AND coalesce(user_id::text, email_hash, host(ip)) IS NOT NULL
       GROUP BY 1
       HAVING count(*) >= $3
       ORDER BY 1`,
      [at, thresholds.windowMinutes, thresholds.denials],
    );
    return rows.map((row) => ({
      key: row.actor,
      severity: 'medium',
      summary: `${count(row.denials, 'accès refusé', 'accès refusés')} pour ${row.actor} en ${thresholds.windowMinutes} min (${count(row.routes, 'route')})`,
      evidence: row.ids,
    }));
  },
};
