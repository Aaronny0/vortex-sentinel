import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { Clock } from './common/clock.ts';
import { AppError } from './common/errors.ts';
import { errorPlugin } from './http/error-plugin.ts';
import { ingestPlugin } from './ingest/ingest-plugin.ts';
import { createReplayGuard, type ReplayGuard } from './ingest/replay-guard.ts';
import { dashboardPlugin } from './http/dashboard-plugin.ts';
import { createOperatorService } from './operators/service.ts';

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
};

export function createApp(deps: AppDeps) {
  const operators = createOperatorService({ pool: deps.appPool, clock: deps.clock, secretKey: deps.operatorSecretKey });
  return new Elysia()
    .use(errorPlugin)
    .get('/health', async () => {
      try {
        await deps.appPool.query('SELECT 1');
        return { status: 'ok' as const };
      } catch {
        throw new AppError(503, 'DATABASE_UNAVAILABLE', 'La base de données est indisponible.');
      }
    })
    .use(ingestPlugin({ pool: deps.ingestPool, clock: deps.clock, secrets: deps.secrets, replayGuard: deps.replayGuard ?? createReplayGuard() }))
    .use(dashboardPlugin({ pool: deps.appPool, clock: deps.clock, operators, dashboardOrigin: deps.dashboardOrigin }));
}
