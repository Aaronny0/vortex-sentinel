import { MINUTE_MS, type Rule } from './types.ts';

const thresholds = { adjustments: 3, historyDays: 7, windowMinutes: 15 };

/**
 * R12 — Pertes de stock répétées : au moins 3 ajustements négatifs sur un même produit en 7 jours (vol, casse ou erreurs
 * de saisie à vérifier). Le produit est identifié par `attributes.subjectId`, envoyé par Vortex sans nom ni modèle.
 */
export const r12StockAdjustments: Rule = {
  id: 'R12',
  version: 1,
  kind: 'window',
  severity: 'medium',
  graceMs: MINUTE_MS,
  quietMs: 60 * MINUTE_MS,
  thresholds,
  async evaluate({ query, at }) {
    const rows = await query<{ product: string; adjustments: number; units: number; members: number; ids: string[] }>(
      `SELECT body->'attributes'->>'subjectId' AS product, count(*)::int AS adjustments,
              -sum((body->'business'->>'quantity')::int)::int AS units,
              count(DISTINCT body->'actor'->>'membershipId')::int AS members,
              (array_agg(id ORDER BY received_at, id))[1:100] AS ids
       FROM sentinel.event
       WHERE type = 'stock.adjust' AND (body->'business'->>'quantity')::int < 0
         AND received_at > $1::timestamptz - make_interval(days => $2) AND received_at <= $1
         AND body->'attributes'->>'subjectId' IS NOT NULL
       GROUP BY 1
       HAVING count(*) >= $3 AND max(received_at) > $1::timestamptz - make_interval(mins => $4)`,
      [at, thresholds.historyDays, thresholds.adjustments, thresholds.windowMinutes],
    );
    return rows.map((row) => ({
      key: `produit ${row.product}`,
      severity: 'medium',
      summary: `${row.adjustments} ajustements négatifs en ${thresholds.historyDays} jours sur le produit ${row.product.slice(0, 8)} (${row.units} unités, ${row.members} membre${row.members > 1 ? 's' : ''})`,
      evidence: row.ids,
    }));
  },
};
