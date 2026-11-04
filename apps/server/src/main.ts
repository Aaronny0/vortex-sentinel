import { createApp } from './app.ts';
import { systemClock } from './common/clock.ts';
import { logError } from './common/safe-log.ts';
import { loadEnv } from './config/env.ts';
import { every } from './common/loop.ts';
import { createPool, ensurePartitions } from './db/pools.ts';
import { ENGINE_INTERVAL_MS, runEngineCycle } from './engine/engine.ts';
import { purgeExpired } from './db/retention.ts';
import { sendPendingNotifications, smtpSender } from './notify/notifier.ts';
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
  webDist: env.WEB_DIST,
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

// Notifications : toutes les 30 s, si un serveur SMTP est configuré.
const mailFrom = env.MAIL_FROM ?? env.SMTP_USER;
const notifications =
  env.SMTP_HOST && mailFrom
    ? every(
        30_000,
        () =>
          sendPendingNotifications(
            appPool,
            clock,
            smtpSender({ host: env.SMTP_HOST!, port: env.SMTP_PORT, secure: (env.SMTP_SECURE ?? String(env.SMTP_PORT === 465)) === 'true', user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: mailFrom }),
            env.DASHBOARD_ORIGIN,
          ),
        (error) => logError('Notifications :', error),
      )
    : undefined;
if (!notifications) console.warn('Notifications désactivées : SMTP_HOST et MAIL_FROM non configurés.');

// Rétention : chaque jour, partitions de plus de 2 ans et clés de déduplication de plus de 30 jours.
const retention = every(
  DAY_MS,
  async () => {
    const result = await purgeExpired(appPool, clock);
    if (result.droppedPartitions) console.log(`Rétention : ${result.droppedPartitions} partition(s) supprimée(s)`);
  },
  (error) => logError('Rétention :', error),
);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(partitions);
  await Promise.all([...probeLoops, engine, retention, ...(notifications ? [notifications] : [])].map((loop) => loop.stop()));
  await app.stop();
  await Promise.all([ingestPool.end(), appPool.end()]);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
