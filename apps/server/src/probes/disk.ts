import { statfs } from 'node:fs/promises';
import type { EventInput } from '@sentinel/schema';
import type { Clock } from '../common/clock.ts';
import { probeEvent, safeCode } from './event.ts';

type FsStats = { bsize: number; blocks: number; bavail: number };

/**
 * Espace libre du système de fichiers qui porte `path`. « Libre » est l'espace disponible pour un processus ordinaire
 * (`bavail`), pas celui réservé à l'administrateur : c'est lui qui manquera à PostgreSQL ou aux journaux.
 */
export async function checkDisk(
  path: string,
  deps: { clock: Clock; statfs?: (path: string) => Promise<FsStats> },
): Promise<EventInput> {
  try {
    const stats = await (deps.statfs ?? statfs)(path);
    const freePercent = stats.blocks > 0 ? Math.round((stats.bavail / stats.blocks) * 1000) / 10 : 0;
    return probeEvent('host.disk', 'success', deps.clock, {
      attributes: { path, freePercent, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize },
    });
  } catch (error) {
    return probeEvent('host.disk', 'failure', deps.clock, {
      attributes: { path, code: safeCode((error as NodeJS.ErrnoException).code, 'UNREADABLE') },
    });
  }
}
