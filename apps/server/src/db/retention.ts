import type { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';

/**
 * Purge quotidienne : partitions d'événements de plus de 2 ans, clés de déduplication de plus de 30 jours. Les durées
 * sont fixées dans la fonction SQL ; un rejeu d'un lot de plus de 30 jours serait alors enregistré deux fois, ce que
 * l'émetteur ne fait pas (tampon en mémoire, réessais bornés).
 */
export async function purgeExpired(pool: Pool, clock: Clock): Promise<{ droppedPartitions: number; deletedKeys: number }> {
  const { rows } = await pool.query<{ dropped_partitions: number; deleted_keys: string }>('SELECT * FROM sentinel.purge_expired($1)', [clock.now()]);
  return { droppedPartitions: rows[0]?.dropped_partitions ?? 0, deletedKeys: Number(rows[0]?.deleted_keys ?? 0) };
}
