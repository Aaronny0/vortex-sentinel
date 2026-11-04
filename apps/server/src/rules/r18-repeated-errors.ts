import { count } from './format.ts';
import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { errors: 3, windowMinutes: 15 };

/**
 * R18 — Fonctionnalité en panne : au moins 3 erreurs serveur (`app.error`) sur une même route, ou 3 effets non exécutés
 * (`command.effect_failed`) d'une même commande, en 15 min, quel que soit le trafic. R04 raisonne en taux et attend
 * 20 requêtes : avec le trafic d'une PME, une route qui échoue à chaque appel lui échapperait.
 */
export const r18RepeatedErrors: Rule = {
  id: 'R18',
  version: 1,
  kind: 'window',
  severity: 'high',
  graceMs: MINUTE_MS,
  quietMs: thresholds.windowMinutes * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ subject: string; kind: string; errors: number; ids: string[] }>(
      `SELECT CASE WHEN type = 'app.error' THEN concat_ws(' ', body->'http'->>'method', body->'http'->>'route')
                   ELSE body->'attributes'->>'command' END AS subject,
              type AS kind, count(*)::int AS errors,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type IN ('app.error', 'command.effect_failed')
         AND received_at > $1::timestamptz - make_interval(mins => $2) AND received_at <= $1
       GROUP BY 1, 2
       HAVING count(*) >= $3
       ORDER BY 2, 1`,
      [at, thresholds.windowMinutes, thresholds.errors],
    );
    return rows
      .filter((row) => row.subject)
      .map((row) =>
        row.kind === 'app.error'
          ? {
              key: `route ${row.subject}`,
              severity: 'high' as const,
              summary: `${count(row.errors, 'erreur serveur', 'erreurs serveur')} sur ${row.subject} en ${thresholds.windowMinutes} min`,
              evidence: row.ids,
            }
          : {
              key: `commande ${row.subject}`,
              severity: 'high' as const,
              summary: `${count(row.errors, 'effet non exécuté', 'effets non exécutés')} après ${row.subject} en ${thresholds.windowMinutes} min (email ou notification)`,
              evidence: row.ids,
            },
      );
  },
};
