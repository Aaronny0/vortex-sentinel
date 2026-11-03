import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { Clock } from './common/clock.ts';
import { AppError } from './common/errors.ts';
import { errorPlugin } from './http/error-plugin.ts';
import { ingestPlugin } from './ingest/ingest-plugin.ts';
import { createReplayGuard, type ReplayGuard } from './ingest/replay-guard.ts';

export type AppDeps = {
  ingestPool: Pool;
  appPool: Pool;
  clock: Clock;
  secrets: readonly string[];
  replayGuard?: ReplayGuard;
};

export function createApp(deps: AppDeps) {
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
    .use(ingestPlugin({ pool: deps.ingestPool, clock: deps.clock, secrets: deps.secrets, replayGuard: deps.replayGuard ?? createReplayGuard() }));
}
