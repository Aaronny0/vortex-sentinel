import type { EventInput } from '@sentinel/schema';
import type { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';
import { every, type Loop } from '../common/loop.ts';
import { logError } from '../common/safe-log.ts';
import { storeBatch } from '../ingest/store.ts';
import { checkDisk } from './disk.ts';
import { checkHealth, type HealthTarget } from './health.ts';
import { checkCertificate, type TlsTarget } from './tls.ts';

export type ProbeConfig = { health: readonly HealthTarget[]; tls: readonly TlsTarget[]; disks: readonly string[] };

/** Rythmes de la conception (§ 3.2) : santé toutes les 30 s, disque toutes les 5 min, certificat chaque jour. */
export const PROBE_INTERVALS_MS = { health: 30_000, disk: 5 * 60_000, tls: 24 * 60 * 60_000 } as const;

/**
 * Chaque tournée lance ses contrôles en parallèle et enregistre leurs résultats en un lot, par le même chemin que les
 * événements de Vortex : les sondes n'ont pas de table à part, leurs résultats sont des événements comme les autres.
 */
export function createProbes(deps: { ingestPool: Pool; clock: Clock; config: ProbeConfig }) {
  const { clock, config } = deps;
  const record = async (checks: Promise<EventInput>[]) => {
    const events = await Promise.all(checks);
    if (events.length > 0) await storeBatch(deps.ingestPool, events, clock.now());
    return events;
  };
  return {
    health: () => record(config.health.map((target) => checkHealth(target, { clock }))),
    tls: () => record(config.tls.map((target) => checkCertificate(target, { clock }))),
    disk: () => record(config.disks.map((path) => checkDisk(path, { clock }))),
  };
}

export type Probes = ReturnType<typeof createProbes>;

/** Démarre les tournées configurées ; une sonde sans cible ne tourne pas. */
export function startProbes(probes: Probes, config: ProbeConfig): Loop[] {
  const kinds = [
    ['health', config.health.length],
    ['tls', config.tls.length],
    ['disk', config.disks.length],
  ] as const;
  return kinds
    .filter(([, count]) => count > 0)
    .map(([kind]) => every(PROBE_INTERVALS_MS[kind], probes[kind], (error) => logError(`Sonde ${kind} :`, error)));
}
