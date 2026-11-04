import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../common/clock.ts';
import { AppError } from '../common/errors.ts';

export const incidentStatuses = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'false_positive'] as const;
export type IncidentStatus = (typeof incidentStatuses)[number];

/** Libellés de la conception (§ 7.3), pour les messages. */
export const statusLabels: Record<IncidentStatus, string> = {
  open: 'Ouvert',
  acknowledged: 'Pris en charge',
  in_progress: 'En cours',
  resolved: 'Résolu',
  closed: 'Clos',
  false_positive: 'Faux positif',
};

/** Cycle de vie (docs/conception.md § 7.3). Clos et faux positif sont définitifs. */
export const allowedTransitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['acknowledged', 'false_positive'],
  acknowledged: ['in_progress', 'false_positive'],
  in_progress: ['resolved', 'false_positive'],
  resolved: ['closed', 'in_progress'],
  closed: [],
  false_positive: [],
};

/** Une résolution, un faux positif ou une réouverture se justifient : ils serviront au calibrage et à l'évaluation. */
const needsComment = (from: IncidentStatus, to: IncidentStatus) => to === 'resolved' || to === 'false_positive' || (from === 'resolved' && to === 'in_progress');

const transitionSchema = z.strictObject({
  incidentId: z.uuid({ error: 'Incident : identifiant invalide.' }),
  to: z.enum(incidentStatuses, { error: 'Statut inconnu.' }),
  actorId: z.uuid({ error: 'Opérateur : identifiant invalide.' }),
  comment: z.string().trim().min(3, { error: 'Commentaire trop court.' }).max(2000, { error: 'Commentaire trop long.' }).optional(),
});

export type TransitionInput = z.input<typeof transitionSchema>;
export type IncidentRow = {
  id: string;
  number: string;
  status: IncidentStatus;
  severity: string;
  assignee_id: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  updated_at: Date;
};

/**
 * Fait passer un incident d'un statut à un autre, au nom d'un opérateur, et l'historise dans la même transaction. La ligne
 * est verrouillée : deux opérateurs qui agissent en même temps sont traités l'un après l'autre, et le second voit le
 * statut laissé par le premier (sa transition peut alors être refusée). La prise en charge assigne l'opérateur.
 */
export async function transitionIncident(pool: Pool, clock: Clock, input: TransitionInput): Promise<IncidentRow> {
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
    throw new AppError(422, 'VALIDATION_FAILED', 'Certains champs sont invalides.', fields);
  }
  const { incidentId, to, actorId, comment } = parsed.data;
  const at = clock.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: IncidentStatus }>('SELECT status FROM sentinel.incident WHERE id = $1 FOR UPDATE', [incidentId]);
    const from = rows[0]?.status;
    if (!from) throw new AppError(404, 'NOT_FOUND', 'Incident introuvable.');
    if (!allowedTransitions[from].includes(to))
      throw new AppError(409, 'INVALID_TRANSITION', `Transition impossible : ${statusLabels[from]} → ${statusLabels[to]}.`);
    if (needsComment(from, to) && !comment)
      throw new AppError(422, 'VALIDATION_FAILED', 'Certains champs sont invalides.', { comment: `Un commentaire est requis pour passer à « ${statusLabels[to]} ».` });

    const { rows: updated } = await client.query<IncidentRow>(
      `UPDATE sentinel.incident SET
         status = $2,
         updated_at = $3,
         assignee_id = CASE WHEN $2 = 'acknowledged' THEN $4::uuid ELSE assignee_id END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN $3 WHEN $2 = 'in_progress' THEN NULL ELSE resolved_at END,
         closed_at = CASE WHEN $2 IN ('closed', 'false_positive') THEN $3 ELSE closed_at END
       WHERE id = $1
       RETURNING id, number::text, status, severity, assignee_id, resolved_at, closed_at, updated_at`,
      [incidentId, to, at, actorId],
    );
    await client.query(
      `INSERT INTO sentinel.incident_history (incident_id, at, actor_id, kind, from_status, to_status, comment)
       VALUES ($1, $2, $3, 'transition', $4, $5, $6)`,
      [incidentId, at, actorId, from, to, comment ?? null],
    );
    await client.query('COMMIT');
    return updated[0]!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Référence lisible d'un incident : INC-000042. */
export const incidentReference = (number: string | number) => `INC-${String(number).padStart(6, '0')}`;
