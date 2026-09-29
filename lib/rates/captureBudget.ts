export type BudgetOutcome<R> =
  | Readonly<{ status: "completed"; value: R }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "source_timeout" }>
  | Readonly<{ status: "run_deadline" }>
  | Readonly<{ status: "not_started" }>;

export type BudgetOptions = Readonly<{
  concurrency: number;
  perSourceMs: number;
  runMs: number;
}>;

export type BudgetResult<R> = Readonly<{
  outcomes: readonly BudgetOutcome<R>[];
  maxObservedConcurrency: number;
}>;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/**
 * Runs `worker` over `items` with a fixed lane count (never Promise.all over the
 * item list), a per-item deadline and a run-level deadline. The worker receives an
 * AbortSignal that is aborted on either deadline. A late settlement after a
 * deadline is ignored, so a timed-out item can never report success.
 * Outcomes are index-aligned with `items`, which keeps summaries deterministic.
 */
export async function runWithBudget<T, R>(
  items: readonly T[],
  worker: (item: T, signal: AbortSignal) => Promise<R>,
  options: BudgetOptions,
): Promise<BudgetResult<R>> {
  requirePositiveInteger(options.concurrency, "concurrency");
  requirePositiveInteger(options.perSourceMs, "perSourceMs");
  requirePositiveInteger(options.runMs, "runMs");

  const run = new AbortController();
  const runTimer = setTimeout(() => run.abort(), options.runMs);
  const outcomes = new Array<BudgetOutcome<R>>(items.length);
  let next = 0;
  let active = 0;
  let maxActive = 0;

  const runOne = (item: T): Promise<BudgetOutcome<R>> =>
    new Promise<BudgetOutcome<R>>((resolve) => {
      const source = new AbortController();
      let settled = false;
      const finish = (outcome: BudgetOutcome<R>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.signal.removeEventListener("abort", onRunAbort);
        resolve(Object.freeze(outcome));
      };
      const onRunAbort = (): void => {
        source.abort();
        finish({ status: "run_deadline" });
      };
      const timer = setTimeout(() => {
        source.abort();
        finish({ status: "source_timeout" });
      }, options.perSourceMs);

      run.signal.addEventListener("abort", onRunAbort, { once: true });
      Promise.resolve()
        .then(() => worker(item, source.signal))
        .then(
          (value) => finish({ status: "completed", value }),
          (error: unknown) => finish({ status: "rejected", error }),
        );
    });

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      if (run.signal.aborted) {
        outcomes[index] = Object.freeze({ status: "not_started" as const });
        continue;
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        outcomes[index] = await runOne(items[index] as T);
      } finally {
        active -= 1;
      }
    }
  };

  try {
    const lanes = Math.min(options.concurrency, items.length);
    await Promise.all(Array.from({ length: lanes }, () => lane()));
  } finally {
    clearTimeout(runTimer);
  }

  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    maxObservedConcurrency: maxActive,
  });
}
