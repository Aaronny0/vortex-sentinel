import { createApp } from './app.ts';
import { systemClock } from './common/clock.ts';
import { logError } from './common/safe-log.ts';
import { loadEnv } from './config/env.ts';
import { every } from './common/loop.ts';
import { createPool, ensurePartitions } from './db/pools.ts';
import { ENGINE_INTERVAL_MS, runEngineCycle } from './engine/engine.ts';
import { MAX_INGEST_BYTES } from './ingest/ingest-plugin.ts';
import { createProbes, startProbes } from './probes/runner.ts';
import { rules } from './rules/registry.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const env = loadEnv();
const clock = systemClock;
const ingestPool = createPool(env.INGEST_DATABASE_URL, 'sentinel-ingest');
const appPool = createPool(env.APP_DATABASE_URL, 'sentinel-app', 5);

await ensurePartitions(appPool, clock);
const partitions = setInterval(() => ensurePartitions(appPool, clock).catch((error) => logError('Partitions :', error)), DAY_MS);

const app = createApp({
  ingestPool,
  appPool,
  clock,
  secrets: env.INGEST_SECRETS,
  operatorSecretKey: Buffer.from(env.OPERATOR_SECRET_KEY, 'hex'),
  dashboardOrigin: env.DASHBOARD_ORIGIN,
}).listen({
  port: env.PORT,
  maxRequestBodySize: MAX_INGEST_BYTES + 1024,
});
console.log(`Sentinel démarré sur le port ${env.PORT}`);

const probeConfig = { health: env.PROBE_TARGETS, tls: env.TLS_TARGETS, disks: env.DISK_PATHS };
const probeLoops = startProbes(createProbes({ ingestPool, clock, config: probeConfig }), probeConfig);
console.log(`Sondes : ${probeConfig.health.length} santé, ${probeConfig.tls.length} certificat, ${probeConfig.disks.length} disque`);

const engine = every(
  ENGINE_INTERVAL_MS,
  () => runEngineCycle(appPool, rules, clock, (rule, error) => logError(`Règle ${rule.id} :`, error)),
  (error) => logError('Moteur :', error),
);
console.log(`Moteur de corrélation : ${rules.length} règles (${rules.map((rule) => rule.id).join(', ')})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(partitions);
  await Promise.all([...probeLoops, engine].map((loop) => loop.stop()));
  await app.stop();
  await Promise.all([ingestPool.end(), appPool.end()]);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
