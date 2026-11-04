import type { Pool } from 'pg';
import { severities, type Rule, type Severity } from '../rules/types.ts';

export type ReplayedFinding = { ruleId: string; key: string; severity: Severity; summary: string; firstAt: Date; lastAt: Date; hits: number; evidence: string[] };

/**
 * Évalue les règles à chaque pas de la période, dans une transaction en lecture seule : rien n'est écrit, ni alerte, ni
 * point de reprise. Les constats d'une même règle et d'une même clé sont regroupés comme le ferait le moteur (premier et
 * dernier instant, nombre de constats, gravité la plus haute, premières preuves).
 */
export async function replay(pool: Pool, selected: readonly Rule[], options: { from: Date; to: Date; stepSeconds: number }): Promise<ReplayedFinding[]> {
  const step = Math.max(1, options.stepSeconds) * 1000;
  const client = await pool.connect();
  const grouped = new Map<string, ReplayedFinding>();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    for (let time = options.from.getTime(); time <= options.to.getTime(); time += step) {
      const at = new Date(time);
      for (const rule of selected) {
        for (const finding of await rule.evaluate({ at, query: async (sql, params) => (await client.query(sql, params)).rows })) {
          const id = `${rule.id} ${finding.key}`;
          const known = grouped.get(id);
          if (!known) grouped.set(id, { ruleId: rule.id, ...finding, evidence: finding.evidence.slice(0, 100), firstAt: at, lastAt: at, hits: 1 });
          else {
            known.lastAt = at;
            known.hits += 1;
            known.summary = finding.summary;
            if (severities.indexOf(finding.severity) > severities.indexOf(known.severity)) known.severity = finding.severity;
          }
        }
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  return [...grouped.values()].sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime() || a.ruleId.localeCompare(b.ruleId));
}
