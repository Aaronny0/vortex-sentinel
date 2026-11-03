import type { EventInput } from '@sentinel/schema';
import type { Pool } from 'pg';

export type StoreResult = { accepted: number; duplicates: number };

/**
 * Enregistre un lot validé en une transaction. Un identifiant déjà connu (renvoi par l'émetteur, ou deux fois dans le lot)
 * est compté comme doublon et ignoré. Deux lots concurrents portant le même identifiant : la clé unique de event_key fait
 * attendre le second, qui le voit alors comme doublon. Les colonnes de recherche sont extraites en SQL depuis le JSON.
 */
export async function storeBatch(pool: Pool, events: readonly EventInput[], receivedAt: Date): Promise<StoreResult> {
  const unique = [...new Map(events.map((event) => [event.id, event])).values()];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sentinel.event_key (id, received_at)
       SELECT id, $2 FROM unnest($1::uuid[]) AS id
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [unique.map((event) => event.id), receivedAt],
    );
    const fresh = new Set(rows.map((row) => row.id));
    const toInsert = unique.filter((event) => fresh.has(event.id));
    if (toInsert.length > 0)
      await client.query(
        `INSERT INTO sentinel.event (id, received_at, occurred_at, source, category, type, outcome,
                                     organization_id, store_id, user_id, email_hash, ip, http_status, body)
         SELECT (e->>'id')::uuid, $2, (e->>'occurredAt')::timestamptz, e->>'source', e->>'category', e->>'type', e->>'outcome',
                (e->'tenant'->>'organizationId')::uuid, (e->'tenant'->>'storeId')::uuid, (e->'actor'->>'userId')::uuid,
                e->'actor'->>'emailHash', (e->'network'->>'ip')::inet, (e->'http'->>'status')::smallint, e
         FROM jsonb_array_elements($1::jsonb) AS e`,
        [JSON.stringify(toInsert), receivedAt],
      );
    await client.query('COMMIT');
    return { accepted: toInsert.length, duplicates: events.length - toInsert.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
