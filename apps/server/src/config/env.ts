import { z } from 'zod';

const hexSecret = z.string().regex(/^[a-f0-9]{64,}$/, { error: 'Secret invalide : au moins 64 caractères hexadécimaux.' });

/** Liste séparée par des virgules ; une variable absente vaut `fallback`. */
const listOf = <T extends z.ZodType<unknown, string>>(item: T, fallback = '') =>
  z
    .string()
    .default(fallback)
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(item));

/** `nom=url` : `vortex-api=https://vortex.example/api/v1/health`. */
const healthTarget = z
  .string()
  .transform((value) => ({ name: value.slice(0, Math.max(value.indexOf('='), 0)), url: value.slice(value.indexOf('=') + 1) }))
  .pipe(
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, { error: 'Cible de sonde : nom=url attendu, nom en minuscules.' }),
      url: z.url({ protocol: /^https?$/, error: 'Cible de sonde : URL http ou https attendue.' }),
    }),
  );

/** `hôte` ou `hôte:port` (443 par défaut). */
const tlsTarget = z
  .string()
  .regex(/^[a-z0-9.-]+(:\d{1,5})?$/i, { error: 'Cible TLS : hôte ou hôte:port attendu.' })
  .transform((value) => {
    const [host, port] = value.split(':');
    return { host: host!.toLowerCase(), port: port ? Number(port) : 443 };
  })
  .pipe(z.strictObject({ host: z.string().min(1), port: z.int().min(1).max(65_535, { error: 'Cible TLS : port invalide.' }) }));

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
  /** Clé AES-256 (64 caractères hexadécimaux) qui chiffre les secrets de double authentification des opérateurs. */
  OPERATOR_SECRET_KEY: z.string().regex(/^[a-f0-9]{64}$/, { error: 'OPERATOR_SECRET_KEY : 64 caractères hexadécimaux.' }),
  /** Origine du tableau de bord, seule autorisée à écrire (connexion, transitions). */
  DASHBOARD_ORIGIN: z.url({ protocol: /^https?$/, error: 'DASHBOARD_ORIGIN doit être une URL http ou https.' }).transform((value) => value.replace(/\/$/, '')).default('http://localhost:4100'),
  /** Serveur SMTP des notifications (incidents élevés et critiques) ; sans SMTP_HOST, aucune notification n'est envoyée. */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.email({ error: 'MAIL_FROM : adresse email attendue.' }).optional(),
  /** Interface construite servie par Sentinel (elle reste disponible quand Vortex est en panne). */
  WEB_DIST: z.string().min(1).default(new URL('../../../web/dist', import.meta.url).pathname),
  /** Points de santé interrogés toutes les 30 s (API et sites de Vortex). */
  PROBE_TARGETS: listOf(healthTarget),
  /** Hôtes dont le certificat est vérifié chaque jour ; vide en local, où Vortex est servi en HTTP. */
  TLS_TARGETS: listOf(tlsTarget),
  /** Systèmes de fichiers surveillés toutes les 5 min : celui de PostgreSQL et des journaux. */
  DISK_PATHS: listOf(z.string().startsWith('/', { error: 'Chemin de disque absolu attendu.' }), '/'),
  /**
   * Démonstration locale sans connexion : le tableau de bord agit comme le premier administrateur actif. Refusé hors de
   * localhost et en production (voir le contrôle ci-dessous) : ce mode ne peut pas partir sur le VPS.
   */
  DEMO_NO_AUTH: z.enum(['on', 'off']).default('off'),
  NODE_ENV: z.string().optional(),
}).refine(
  (env) => env.DEMO_NO_AUTH === 'off' || (env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.DASHBOARD_ORIGIN)),
  { error: 'DEMO_NO_AUTH=on est réservé au développement local (DASHBOARD_ORIGIN en http://localhost, hors production).', path: ['DEMO_NO_AUTH'] },
);

export type Env = z.infer<typeof envSchema>;

/** Refuse de démarrer sur une configuration incomplète : le message nomme la variable, jamais sa valeur. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `- ${issue.path.join('.') || 'environnement'} : ${issue.message}`);
  throw new Error(`Configuration invalide :\n${problems.join('\n')}`);
}
