import { TIMESTAMP_TOLERANCE_S } from './signature.ts';

export type ReplayGuard = { firstSeen(signature: string, now: Date): boolean };

/**
 * Refuse une requête signée déjà reçue. Une signature n'est valable que ±300 s : la garder 600 s suffit, la table reste
 * bornée. En mémoire, pour une seule instance ; la déduplication par identifiant d'événement reste la garantie de fond.
 */
export function createReplayGuard(retentionMs = 2 * TIMESTAMP_TOLERANCE_S * 1000): ReplayGuard {
  const seen = new Map<string, number>();
  return {
    firstSeen(signature, now) {
      const at = now.getTime();
      for (const [key, seenAt] of seen) {
        if (at - seenAt <= retentionMs) break; // insertion ordonnée : le reste est plus récent
        seen.delete(key);
      }
      if (seen.has(signature)) return false;
      seen.set(signature, at);
      return true;
    },
  };
}
