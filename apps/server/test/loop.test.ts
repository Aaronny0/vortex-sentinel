import { describe, expect, test } from 'bun:test';
import { every } from '../src/common/loop.ts';

/** Promesse résolue de l'extérieur : le test décide quand une exécution se termine. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

describe('boucle de tâches', () => {
  test('n’enchaîne jamais deux exécutions en même temps, et stop attend la fin', async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const gates = [deferred(), deferred()];
    const secondStarted = deferred();
    const loop = every(0, async () => {
      runs += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (runs === 2) secondStarted.resolve();
      await gates[Math.min(runs - 1, 1)]!.promise;
      running -= 1;
    }, () => undefined);

    gates[0]!.resolve();
    await secondStarted.promise;
    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await Bun.sleep(0);
    expect(stopped).toBe(false); // la deuxième exécution est en cours
    gates[1]!.resolve();
    await stopping;
    expect({ runs, maxRunning }).toEqual({ runs: 2, maxRunning: 1 });
  });

  test('une erreur est signalée et la boucle continue', async () => {
    const errors: unknown[] = [];
    const third = deferred();
    let runs = 0;
    const loop = every(0, async () => {
      runs += 1;
      if (runs === 3) third.resolve();
      if (runs === 1) throw new Error('échec de la première tournée');
    }, (error) => errors.push(error));
    await third.promise;
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(runs).toBeGreaterThanOrEqual(3);
  });
});
