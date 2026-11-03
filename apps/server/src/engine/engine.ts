import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Clock } from '../common/clock.ts';
import { severities, type Finding, type Rule } from '../rules/types.ts';

/** Espace des verrous consultatifs du moteur (« SENT ») : la seconde clé est l'empreinte de l'identifiant de règle. */
const LOCK_NAMESPACE = 0x53454e54;
const MAX_EVIDENCE = 100;

export const ENGINE_INTERVAL_MS = 30_000;

const findingSchema = z.strictObject({
  key: z.string().min(1).max(200),
  severity: z.enum(severities),
  summary: z.string().min(1).max(500),
  evidence: z.array(z.uuid()).min(1).max(MAX_EVIDENCE),
});

export type RuleRun =
  | { status: 'evaluated'; at: Date; findings: number; opened: number; closed: number }
  | { status: 'skipped'; reason: 'locked' | 'up_to_date' };

/**
 * Évalue une règle à l'instant `maintenant − délai de grâce`, dans une seule transaction : verrou de la règle, lecture du
 * point de reprise, évaluation, écriture des alertes, clôture des alertes calmes, avancement du point de reprise. Si une
 * étape échoue, rien n'est écrit et le cycle suivant repart du même point. Une autre instance qui tient le verrou fait
 * sauter le cycle au lieu de l'attendre.
 */
export async function runRule(pool: Pool, rule: Rule, clock: Clock): Promise<RuleRun> {
  const at = new Date(clock.now().getTime() - rule.graceMs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS locked', [LOCK_NAMESPACE, rule.id]);
    if (!lock[0]?.locked) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'locked' };
    }
    const { rows: checkpoint } = await client.query<{ evaluated_to: Date }>('SELECT evaluated_to FROM sentinel.rule_checkpoint WHERE rule_id = $1', [rule.id]);
    if (checkpoint[0] && checkpoint[0].evaluated_to.getTime() >= at.getTime()) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'up_to_date' };
    }

    const findings = (await rule.evaluate({ at, query: async (sql, params) => (await client.query(sql, params)).rows })).map((finding) =>
      findingSchema.parse(finding),
    );
    let opened = 0;
    for (const finding of findings) if (await recordFinding(client, rule, finding, at)) opened += 1;

    const { rowCount: closed } = await client.query(
      `UPDATE sentinel.alert SET status = 'closed', closed_at = $2
       WHERE rule_id = $1 AND status = 'open' AND last_seen_at < $2::timestamptz - make_interval(secs => $3)`,
      [rule.id, at, rule.quietMs / 1000],
    );
    await client.query(
      `INSERT INTO sentinel.rule_checkpoint (rule_id, evaluated_to, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (rule_id) DO UPDATE SET evaluated_to = EXCLUDED.evaluated_to, updated_at = EXCLUDED.updated_at`,
      [rule.id, at, clock.now()],
    );
    await client.query('COMMIT');
    return { status: 'evaluated', at, findings: findings.length, opened, closed: closed ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ouvre une alerte, ou rejoint l'alerte ouverte de même règle et même clé : compteur incrémenté, gravité portée au plus
 * haut, résumé actualisé, nouvelles preuves ajoutées après les premières. Renvoie vrai si l'alerte est nouvelle.
 */
async function recordFinding(client: PoolClient, rule: Rule, finding: Finding, at: Date): Promise<boolean> {
  const { rows } = await client.query<{ opened: boolean }>(
    `INSERT INTO sentinel.alert (rule_id, rule_version, key, severity, summary, evidence, thresholds, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $8)
     ON CONFLICT (rule_id, key) WHERE status = 'open' DO UPDATE SET
       hits = alert.hits + 1,
       last_seen_at = EXCLUDED.last_seen_at,
       summary = EXCLUDED.summary,
       severity = CASE WHEN array_position($9::text[], EXCLUDED.severity) > array_position($9::text[], alert.severity)
                       THEN EXCLUDED.severity ELSE alert.severity END,
       evidence = (alert.evidence || ARRAY(SELECT id FROM unnest(EXCLUDED.evidence) AS id WHERE id <> ALL (alert.evidence)))[1:$10]
     RETURNING (xmax = 0) AS opened`,
    [rule.id, rule.version, finding.key, finding.severity, finding.summary, finding.evidence, rule.thresholds, at, severities, MAX_EVIDENCE],
  );
  return rows[0]?.opened ?? false;
}

/** Un cycle : chaque règle à son tour. L'échec d'une règle est signalé et n'empêche pas les autres d'être évaluées. */
export async function runEngineCycle(pool: Pool, rules: readonly Rule[], clock: Clock, onError: (rule: Rule, error: unknown) => void) {
  const results: Record<string, RuleRun> = {};
  for (const rule of rules) {
    try {
      results[rule.id] = await runRule(pool, rule, clock);
    } catch (error) {
      onError(rule, error);
    }
  }
  return results;
}
