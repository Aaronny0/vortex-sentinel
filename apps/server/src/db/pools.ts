import { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';
import { logError } from '../common/safe-log.ts';

/**
 * Sessions en UTC : sinon « 30 jours » se compte dans le fuseau du serveur, et un changement d'heure élargit ou rétrécit
 * les fenêtres des règles d'une heure.
 */
export const UTC_SESSION = '-c timezone=UTC';

/** Un pool par rôle : chaque processus se connecte avec le login qui n'a que les droits de sa tâche. */
export function createPool(connectionString: string, applicationName: string, max = 10): Pool {
  const pool = new Pool({ connectionString, application_name: applicationName, max, connectionTimeoutMillis: 10_000, options: UTC_SESSION });
  pool.on('error', (error) => logError('Connexion PostgreSQL :', error));
  return pool;
}

/** Partitions du mois courant et des deux suivants ; appelée au démarrage puis chaque jour. */
export async function ensurePartitions(appPool: Pool, clock: Clock, months = 3): Promise<number> {
  const today = clock.now().toISOString().slice(0, 10);
  const { rows } = await appPool.query<{ created: number }>('SELECT sentinel.ensure_event_partitions($1::date, $2) AS created', [today, months]);
  return rows[0]?.created ?? 0;
}
