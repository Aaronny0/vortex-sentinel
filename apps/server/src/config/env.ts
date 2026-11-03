import { z } from 'zod';

const hexSecret = z.string().regex(/^[a-f0-9]{64,}$/, { error: 'Secret invalide : au moins 64 caractères hexadécimaux.' });

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  /** Login membre de `sentinel_ingest` : insère des événements, rien d'autre. */
  INGEST_DATABASE_URL: z.url({ error: 'INGEST_DATABASE_URL doit être une URL PostgreSQL.' }),
  /** Login membre de `sentinel_app` : lecture des événements, partitions, alertes et incidents. */
  APP_DATABASE_URL: z.url({ error: 'APP_DATABASE_URL doit être une URL PostgreSQL.' }),
  /** Secrets HMAC partagés avec l'émetteur de Vortex, séparés par des virgules : deux au plus, pendant une rotation. */
  INGEST_SECRETS: z
    .string()
    .transform((value) => value.split(',').map((secret) => secret.trim()))
    .pipe(z.array(hexSecret).min(1).max(2, { error: 'Deux secrets au plus (rotation).' })),
});

export type Env = z.infer<typeof envSchema>;

/** Refuse de démarrer sur une configuration incomplète : le message nomme la variable, jamais sa valeur. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `- ${issue.path.join('.') || 'environnement'} : ${issue.message}`);
  throw new Error(`Configuration invalide :\n${problems.join('\n')}`);
}
