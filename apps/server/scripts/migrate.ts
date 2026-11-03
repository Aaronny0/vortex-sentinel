// Applique les migrations avec le login propriétaire (OWNER_DATABASE_URL), le seul qui ait le droit de modifier le schéma.
//   OWNER_DATABASE_URL=postgresql://… bun run db:migrate
import { Client } from 'pg';
import { migrate } from '../src/db/migrate.ts';

const url = process.env.OWNER_DATABASE_URL;
if (!url) throw new Error('OWNER_DATABASE_URL est requis.');

const client = new Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Base à jour.');
} finally {
  await client.end();
}
