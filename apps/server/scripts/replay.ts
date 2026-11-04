// Rejoue les règles sur une période passée, sans rien écrire, et liste ce qu'elles auraient détecté.
//   bun run replay -- --from 2026-11-04T08:00:00Z --to 2026-11-04T18:00:00Z [--rules R05,R07] [--step 60] [--json]
// Mêmes événements, mêmes versions de règles : mêmes constats (docs/backend.md § 5.4). C'est la base des scénarios
// d'évaluation : on rejoue une attaque injectée et on mesure le délai et l'exactitude de la détection.
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/config/env.ts';
import { createPool } from '../src/db/pools.ts';
import { rules } from '../src/rules/registry.ts';
import { replay } from '../src/engine/replay.ts';

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, rules: { type: 'string' }, step: { type: 'string', default: '60' }, json: { type: 'boolean', default: false } },
});
const from = new Date(values.from ?? '');
const to = new Date(values.to ?? '');
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('--from et --to : deux dates ISO, la première avant la seconde.');
const selected = values.rules ? rules.filter((rule) => values.rules!.split(',').includes(rule.id)) : rules;
const pool = createPool(loadEnv().APP_DATABASE_URL, 'sentinel-replay', 1);
try {
  const findings = await replay(pool, selected, { from, to, stepSeconds: Number(values.step) });
  if (values.json) console.log(JSON.stringify(findings, null, 2));
  else {
    console.log(`${findings.length} constat(s) entre ${from.toISOString()} et ${to.toISOString()} (${selected.length} règles)`);
    for (const finding of findings)
      console.log(`${finding.ruleId}  ${finding.severity.padEnd(8)} ${finding.firstAt.toISOString()} → ${finding.lastAt.toISOString()}  ×${finding.hits}  ${finding.summary}`);
  }
} finally {
  await pool.end();
}
