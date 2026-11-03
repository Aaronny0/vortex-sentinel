import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { migrate } from '../src/db/migrate.ts';

/**
 * Base jetable par suite de tests : créée, migrée, puis supprimée. Connexion d'administration (CREATEDB et CREATEROLE) :
 * TEST_DATABASE_ADMIN_URL, sinon le socket local avec l'utilisateur du système. Les logins de test ont leurs propres noms
 * et un mot de passe tiré à chaque suite : ceux du développement local ne sont jamais touchés.
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql:///postgres?host=/var/run/postgresql';
/** Les logins s'authentifient par mot de passe, donc en TCP. */
const LOGIN_HOST = process.env.TEST_DATABASE_HOST ?? '127.0.0.1:5432';

const withDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

export type TestDb = {
  name: string;
  admin: Client;
  ingestPool: Pool;
  appPool: Pool;
  drop(): Promise<void>;
};

const LOGINS = { ingest: 'sentinel_test_ingest', app: 'sentinel_test_app' } as const;

export async function createTestDb(): Promise<TestDb> {
  const name = `sentinel_test_${randomBytes(6).toString('hex')}`;
  const server = new Client({ connectionString: ADMIN_URL });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);

  const admin = new Client({ connectionString: withDatabase(ADMIN_URL, name) });
  await admin.connect();
  await migrate(admin);

  const passwords = { ingest: randomBytes(24).toString('hex'), app: randomBytes(24).toString('hex') };
  for (const [kind, group] of [['ingest', 'sentinel_ingest'], ['app', 'sentinel_app']] as const) {
    const login = LOGINS[kind];
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login]);
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    const { rows } = await admin.query<{ sql: string }>(`SELECT format('${verb} ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql`, [login, passwords[kind]]);
    await admin.query(rows[0]!.sql);
    await admin.query(`GRANT ${group} TO ${login}`);
  }

  const loginUrl = (kind: keyof typeof LOGINS) => `postgresql://${LOGINS[kind]}:${passwords[kind]}@${LOGIN_HOST}/${name}`;
  const ingestPool = new Pool({ connectionString: loginUrl('ingest'), max: 4 });
  const appPool = new Pool({ connectionString: loginUrl('app'), max: 2 });

  return {
    name,
    admin,
    ingestPool,
    appPool,
    async drop() {
      await Promise.all([ingestPool.end(), appPool.end()]);
      await admin.end();
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.end();
    },
  };
}
