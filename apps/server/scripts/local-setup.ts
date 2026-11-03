// Prépare le développement local : base `sentinel` dans le PostgreSQL de la machine (séparée de celle de Vortex),
// migrations, logins des processus, puis `.env`. Relançable sans risque : rien n'est supprimé, aucun secret existant
// n'est remplacé.
//   bun run local:setup
// Connexion d'administration (CREATEDB et CREATEROLE) : LOCAL_PG_ADMIN_URL, sinon le socket local avec l'utilisateur du système.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../src/db/migrate.ts';

const DB_NAME = 'sentinel';
const ADMIN_URL = process.env.LOCAL_PG_ADMIN_URL ?? 'postgresql:///postgres?host=/var/run/postgresql';
const LOGIN_HOST = process.env.LOCAL_PG_HOST ?? '127.0.0.1:5432';
const envPath = join(import.meta.dir, '../.env');

const parseEnv = (text: string) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map(([, key, value]) => [key!, value!]),
  );
const current: Record<string, string> = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};

/** Mot de passe déjà présent dans l'URL du `.env`, sinon un nouveau. */
const passwordFrom = (url: string | undefined) => {
  const password = url ? decodeURIComponent(new URL(url).password) : '';
  return /^[a-f0-9]{48,}$/.test(password) ? password : randomBytes(32).toString('hex');
};
const withDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

const server = new Client({ connectionString: ADMIN_URL });
try {
  await server.connect();
} catch (error) {
  console.error(
    `Connexion PostgreSQL impossible : ${(error as Error).message}\n` +
      'Créer un rôle pour votre utilisateur système, une seule fois :\n  sudo -u postgres createuser --createdb --createrole "$USER"\n' +
      'ou définir LOCAL_PG_ADMIN_URL=postgresql://UTILISATEUR:MOT_DE_PASSE@127.0.0.1:5432/postgres',
  );
  process.exit(1);
}
try {
  const { rowCount } = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (!rowCount) {
    await server.query(`CREATE DATABASE ${DB_NAME}`);
    console.log(`Base « ${DB_NAME} » créée.`);
  }
} finally {
  await server.end();
}

const owner = new Client({ connectionString: withDatabase(ADMIN_URL, DB_NAME) });
await owner.connect();
const logins = [
  { name: 'sentinel_ingest_login', group: 'sentinel_ingest', env: 'INGEST_DATABASE_URL' },
  { name: 'sentinel_app_login', group: 'sentinel_app', env: 'APP_DATABASE_URL' },
] as const;
const urls: Record<string, string> = {};
try {
  const applied = await migrate(owner);
  console.log(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Base à jour.');
  for (const login of logins) {
    const password = passwordFrom(current[login.env]);
    const exists = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login.name]);
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    const { rows } = await owner.query<{ sql: string }>(`SELECT format('${verb} ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql`, [login.name, password]);
    await owner.query(rows[0]!.sql);
    await owner.query(`GRANT ${login.group} TO ${login.name}`);
    urls[login.env] = `postgresql://${login.name}:${password}@${LOGIN_HOST}/${DB_NAME}`;
  }
} finally {
  await owner.end();
}

const next = {
  PORT: current.PORT ?? '4100',
  ...urls,
  INGEST_SECRETS: current.INGEST_SECRETS ?? randomBytes(32).toString('hex'),
  // API de Vortex en développement (apps/api, port 3001).
  PROBE_TARGETS: current.PROBE_TARGETS ?? 'vortex-api=http://127.0.0.1:3001/api/v1/health',
  TLS_TARGETS: current.TLS_TARGETS ?? '',
  DISK_PATHS: current.DISK_PATHS ?? '/',
};
writeFileSync(envPath, `${Object.entries(next).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
console.log(`Fichier ${envPath} prêt (non versionné). Démarrage : bun run dev`);
