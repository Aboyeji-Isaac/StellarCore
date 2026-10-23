export type PanelRequestSnapshot<T> = Readonly<{
  data: T;
  loading: boolean;
  error: string | null;
}>;

/** Only the most recently started request may publish panel state. */
export function createPanelRequestState<T>(
  initialData: T,
  fallbackError = "Unable to load data.",
) {
  let generation = 0;
  let snapshot: PanelRequestSnapshot<T> = Object.freeze({
    data: initialData,
    loading: false,
    error: null,
  });
  const listeners = new Set<() => void>();
  const publish = (next: PanelRequestSnapshot<T>) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async refresh(load: () => Promise<T>): Promise<void> {
      const requestGeneration = ++generation;
      publish({ ...snapshot, loading: true, error: null });
      try {
        const data = await load();
        if (requestGeneration !== generation) return;
        publish({ data, loading: false, error: null });
      } catch (error) {
        if (requestGeneration !== generation) return;
        publish({
          ...snapshot,
          loading: false,
          error: error instanceof Error ? error.message : fallbackError,
        });
      }
    },
    /** Invalidate pending completions when a panel leaves the screen. */
    cancel() {
      ++generation;
      publish({ ...snapshot, loading: false });
    },
  };
}
