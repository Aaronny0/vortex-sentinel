// Crée un opérateur (le premier administrateur, notamment) : aucune création de compte en libre-service.
//   bun run operator:create -- --email awa@ministere.example --name "Awa K." --role admin
// Le mot de passe est demandé au terminal (12 caractères au moins), jamais passé en argument ni écrit dans un journal.
// La double authentification s'active à la première connexion au tableau de bord.
import { parseArgs } from 'node:util';
import { systemClock } from '../src/common/clock.ts';
import { AppError } from '../src/common/errors.ts';
import { loadEnv } from '../src/config/env.ts';
import { createPool } from '../src/db/pools.ts';
import { createOperatorService } from '../src/operators/service.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' } } });
const env = loadEnv();
const password = prompt('Mot de passe (12 caractères au moins) :') ?? '';
const pool = createPool(env.APP_DATABASE_URL, 'sentinel-operator-create', 1);
try {
  const operators = createOperatorService({ pool, clock: systemClock, secretKey: Buffer.from(env.OPERATOR_SECRET_KEY, 'hex') });
  const operator = await operators.createOperator({ email: values.email, name: values.name, role: values.role, password }, null);
  console.log(`Opérateur créé : ${operator.name} (${operator.role}). Double authentification à activer à la première connexion.`);
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.message}${error.fields ? ` ${Object.values(error.fields).join(' ')}` : ''}`);
    process.exitCode = 1;
  } else throw error;
} finally {
  await pool.end();
}
