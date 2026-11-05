import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { Clock } from './common/clock.ts';
import { AppError } from './common/errors.ts';
import { errorPlugin } from './http/error-plugin.ts';
import { INGEST_RATE, ingestPlugin } from './ingest/ingest-plugin.ts';
import { createReplayGuard, type ReplayGuard } from './ingest/replay-guard.ts';
import { dashboardPlugin } from './http/dashboard-plugin.ts';
import { staticPlugin } from './http/static-plugin.ts';
import { createOperatorService } from './operators/service.ts';

/** Au-delà, le moteur de corrélation est en retard : la santé passe en « dégradée ». */
export const ENGINE_LATE_SECONDS = 120;

export type AppDeps = {
  ingestPool: Pool;
  appPool: Pool;
  clock: Clock;
  secrets: readonly string[];
  replayGuard?: ReplayGuard;
  /** Clé AES-256 des secrets TOTP des opérateurs (32 octets). */
  operatorSecretKey: Buffer;
  /** Origine du tableau de bord (`https://sentinel.example`) : seule autorisée à écrire. */
  dashboardOrigin: string;
  /** Démonstration locale sans connexion (DEMO_NO_AUTH). */
  demoNoAuth?: boolean;
  /** Débit d'ingestion (tests) ; par défaut INGEST_RATE. */
  ingestRate?: typeof INGEST_RATE;
  /** Dossier de l'interface construite ; absent : l'API seule. */
  webDist?: string;
};

export function createApp(deps: AppDeps) {
  const operators = createOperatorService({ pool: deps.appPool, clock: deps.clock, secretKey: deps.operatorSecretKey });
  return new Elysia()
    .use(errorPlugin)
    // Surveiller le surveillant (docs/backend.md § 7) : base joignable et moteur à jour. Un moteur sans cycle depuis plus
    // de 2 minutes rend la santé « dégradée » (503) : une sonde externe le voit, même si Sentinel ne peut plus alerter.
    .get('/health', async ({ set }) => {
      let engine: { lastCycle: Date | null; rules: number };
      try {
        const { rows } = await deps.appPool.query<{ last_cycle: Date | null; rules: number }>(
          'SELECT max(updated_at) AS last_cycle, count(*)::int AS rules FROM sentinel.rule_checkpoint',
        );
        engine = { lastCycle: rows[0]?.last_cycle ?? null, rules: rows[0]?.rules ?? 0 };
      } catch {
        throw new AppError(503, 'DATABASE_UNAVAILABLE', 'La base de données est indisponible.');
      }
      const lagSeconds = engine.lastCycle ? Math.round((deps.clock.now().getTime() - engine.lastCycle.getTime()) / 1000) : null;
      const late = lagSeconds !== null && lagSeconds > ENGINE_LATE_SECONDS;
      set.headers['cache-control'] = 'no-store';
      if (late) set.status = 503;
      return { status: late ? ('degraded' as const) : ('ok' as const), engine: { lastCycle: engine.lastCycle?.toISOString() ?? null, lagSeconds, rules: engine.rules } };
    })
    .use(ingestPlugin({ pool: deps.ingestPool, clock: deps.clock, secrets: deps.secrets, replayGuard: deps.replayGuard ?? createReplayGuard(), rate: deps.ingestRate }))
    .use(dashboardPlugin({ pool: deps.appPool, clock: deps.clock, operators, dashboardOrigin: deps.dashboardOrigin, demoNoAuth: deps.demoNoAuth }))
    .use(deps.webDist ? staticPlugin(deps.webDist) : new Elysia({ name: 'static-off' }));
}
