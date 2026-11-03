export type Loop = { stop(): Promise<void> };

/**
 * Exécute `task` tout de suite, puis `intervalMs` après la fin de chaque exécution : deux exécutions ne se chevauchent
 * jamais, même si l'une dépasse l'intervalle. Une erreur est signalée et n'arrête pas la boucle. `stop` attend la fin
 * de l'exécution en cours.
 */
export function every(intervalMs: number, task: () => Promise<unknown>, onError: (error: unknown) => void): Loop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(() => void (current = tick()), intervalMs);
  };
  let current = tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
