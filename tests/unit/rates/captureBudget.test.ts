import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { runWithBudget } from "@/lib/rates/captureBudget";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const hang = (): Promise<never> => new Promise<never>(() => undefined);

test("a hung source times out while independent sources complete", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = runWithBudget(
      ["hung", "a", "b"],
      async (item) => (item === "hung" ? hang() : item),
      { concurrency: 2, perSourceMs: 1_000, runMs: 10_000 },
    );
    await tick();
    mock.timers.tick(1_000);
    const { outcomes } = await pending;
    assert.deepEqual(outcomes.map((o) => o.status), ["source_timeout", "completed", "completed"]);
  } finally {
    mock.timers.reset();
  }
});

test("concurrency never exceeds the configured bound", async () => {
  let active = 0;
  let peak = 0;
  const { maxObservedConcurrency, outcomes } = await runWithBudget(
    [1, 2, 3, 4, 5, 6, 7],
    async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return n;
    },
    { concurrency: 3, perSourceMs: 5_000, runMs: 50_000 },
  );
  assert.equal(peak, 3);
  assert.equal(maxObservedConcurrency, 3);
  assert.equal(outcomes.every((o) => o.status === "completed"), true);
});

test("run deadline and source timeout are distinct typed results", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let seenSignal: AbortSignal | undefined;
    const pending = runWithBudget(
      ["hung", "later-1", "later-2"],
      async (item, signal) => {
        seenSignal = signal;
        return hang();
      },
      { concurrency: 1, perSourceMs: 5_000, runMs: 3_000 },
    );
    await tick();
    mock.timers.tick(3_000);
    const { outcomes } = await pending;
    assert.deepEqual(outcomes.map((o) => o.status), ["run_deadline", "not_started", "not_started"]);
    assert.equal(seenSignal?.aborted, true);
  } finally {
    mock.timers.reset();
  }
});

test("a late settlement after timeout cannot flip the outcome to success", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release: (value: string) => void = () => undefined;
    const pending = runWithBudget(
      ["slow"],
      () => new Promise<string>((resolve) => { release = resolve; }),
      { concurrency: 1, perSourceMs: 500, runMs: 10_000 },
    );
    await tick();
    mock.timers.tick(500);
    release("too-late");
    const { outcomes } = await pending;
    assert.equal(outcomes[0]?.status, "source_timeout");
  } finally {
    mock.timers.reset();
  }
});

test("invalid budgets are rejected", async () => {
  await assert.rejects(
    runWithBudget([1], async (n) => n, { concurrency: 0, perSourceMs: 1, runMs: 1 }),
    RangeError,
  );
});
