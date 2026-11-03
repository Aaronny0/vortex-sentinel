import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

export const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations');

/** Clé du verrou consultatif : deux déploiements simultanés n'appliquent pas les mêmes migrations. */
const LOCK_KEY = 0x53_45_4e_54; // « SENT »

type Migration = { name: string; sql: string; checksum: string };

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applique les migrations manquantes, chacune dans sa transaction. Une migration déjà appliquée dont le fichier a changé
 * arrête tout : on ne réécrit pas l'histoire d'une base, on ajoute une migration.
 */
export async function migrate(client: Client, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
    name       text        PRIMARY KEY,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migration');
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    const done: string[] = [];
    for (const migration of readMigrations(dir)) {
      const known = applied.get(migration.name);
      if (known === migration.checksum) continue;
      if (known) throw new Error(`La migration ${migration.name} a été modifiée après application : créer une nouvelle migration.`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migration (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      done.push(migration.name);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
