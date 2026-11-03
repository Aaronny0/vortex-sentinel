/** Seul accès à l'heure du système : le reste du code reçoit une horloge, ce qui rend chaque détection rejouable. */
export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

/** Horloge de test : fixe, avancée explicitement par le test. */
export function manualClock(start: Date | string): Clock & { advance(ms: number): void; set(at: Date | string): void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => void (current += ms),
    set: (at) => void (current = new Date(at).getTime()),
  };
}
