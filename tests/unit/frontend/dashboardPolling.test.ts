import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDashboardPoller,
  DASHBOARD_REFRESH_INTERVAL_MS,
  type PollingClock,
  type PollingVisibility,
} from "@/lib/dashboard/polling";

const INTERVAL = DASHBOARD_REFRESH_INTERVAL_MS;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function createControlledClock(): Readonly<{
  clock: PollingClock;
  scheduledTimers: () => number;
  advance: (milliseconds: number) => Promise<void>;
}> {
  let current = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return Object.freeze({
    clock: Object.freeze({
      now: () => current,
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = nextHandle++;
        timers.set(handle, { at: current + Math.max(0, delayMs), callback });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    }),
    scheduledTimers: () => timers.size,
    async advance(milliseconds: number) {
      const target = current + milliseconds;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        current = next[1].at;
        next[1].callback();
        await settle();
      }
      current = target;
      await settle();
    },
  });
}

function createControlledVisibility(initial = true): Readonly<{
  visibility: PollingVisibility;
  setVisible: (visible: boolean) => void;
  subscriberCount: () => number;
}> {
  let visible = initial;
  const listeners = new Set<() => void>();

  return Object.freeze({
    visibility: Object.freeze({
      isVisible: () => visible,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    setVisible(next: boolean) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
    subscriberCount: () => listeners.size,
  });
}

function harness() {
  const time = createControlledClock();
  const page = createControlledVisibility(true);
  const refreshes: number[] = [];
  const errors: unknown[] = [];

  const poller = createDashboardPoller({
    clock: time.clock,
    visibility: page.visibility,
    refresh: () => {
      refreshes.push(time.clock.now());
    },
    onError: (error) => errors.push(error),
  });

  return { ...time, ...page, poller, refreshes, errors };
}

test("a visible dashboard holds one timer and refreshes once per documented interval", async () => {
  const view = harness();

  view.poller.start();
  assert.equal(view.poller.isRunning(), true);
  assert.equal(view.scheduledTimers(), 1, "start must schedule exactly one timer");

  await view.advance(INTERVAL - 1);
  assert.deepEqual(view.refreshes, [], "no refresh may run before the interval elapses");

  await view.advance(1);
  assert.equal(view.refreshes.length, 1);
  assert.equal(view.scheduledTimers(), 1, "each tick reschedules exactly one timer");

  await view.advance(INTERVAL * 3);
  assert.equal(view.refreshes.length, 4);
  assert.equal(view.scheduledTimers(), 1, "ticks must never accumulate duplicate timers");
});

test("an inactive dashboard cancels its timer and issues no requests", async () => {
  const view = harness();
  view.poller.start();

  await view.advance(INTERVAL / 2);
  view.setVisible(false);
  assert.equal(view.scheduledTimers(), 0, "hiding the page must cancel the pending timer");

  await view.advance(INTERVAL * 5);
  assert.deepEqual(view.refreshes, [], "a hidden dashboard must not poll");
  assert.equal(view.scheduledTimers(), 0);
});

test("reactivation before the interval elapses waits for the remainder, then resumes", async () => {
  const view = harness();
  view.poller.start();

  await view.advance(INTERVAL / 2);
  view.setVisible(false);
  await view.advance(1_000);
  view.setVisible(true);

  assert.equal(view.scheduledTimers(), 1, "reactivation schedules one timer");
  await view.advance(INTERVAL / 2 - 1_000 - 1);
  assert.deepEqual(view.refreshes, []);
  await view.advance(1);
  assert.equal(view.refreshes.length, 1);

  await view.advance(INTERVAL);
  assert.equal(view.refreshes.length, 2);
});

test("reactivation after the interval elapsed refreshes immediately and resumes the interval", async () => {
  const view = harness();
  view.poller.start();

  view.setVisible(false);
  await view.advance(INTERVAL * 4);
  view.setVisible(true);
  await settle();

  assert.equal(view.refreshes.length, 1, "an overdue page refreshes once on reactivation");
  assert.equal(view.scheduledTimers(), 1);

  await view.advance(INTERVAL);
  assert.equal(view.refreshes.length, 2);
});

test("stop cleans up the timer and subscription, is idempotent, and restart does not duplicate", async () => {
  const view = harness();

  view.poller.start();
  view.poller.start();
  assert.equal(view.scheduledTimers(), 1, "a repeated start must not add a timer");
  assert.equal(view.subscriberCount(), 1, "a repeated start must not add a subscription");

  view.poller.stop();
  assert.equal(view.poller.isRunning(), false);
  assert.equal(view.scheduledTimers(), 0);
  assert.equal(view.subscriberCount(), 0);

  view.poller.stop();
  await view.advance(INTERVAL * 2);
  view.setVisible(false);
  view.setVisible(true);
  await view.advance(INTERVAL * 2);
  assert.deepEqual(view.refreshes, [], "a stopped poller must stay inert");

  view.poller.start();
  assert.equal(view.subscriberCount(), 1);
  assert.equal(view.scheduledTimers(), 1);
  await view.advance(INTERVAL);
  assert.equal(view.refreshes.length, 1);
});

test("a failing refresh is reported without stopping later refreshes", async () => {
  const view = harness();
  let attempts = 0;
  view.poller.stop();

  const poller = createDashboardPoller({
    clock: view.clock,
    visibility: view.visibility,
    refresh: async () => {
      attempts++;
      if (attempts === 1) throw new Error("refresh failed");
    },
    onError: (error) => view.errors.push(error),
  });
  poller.start();

  await view.advance(INTERVAL);
  assert.equal(attempts, 1);
  assert.equal(view.errors.length, 1);
  assert.equal(view.scheduledTimers(), 1, "a failure must not cancel the next refresh");

  await view.advance(INTERVAL);
  assert.equal(attempts, 2);
  assert.equal(view.errors.length, 1);
});

test("the dashboard mounts the poller and tears it down on unmount", () => {
  const page = readFileSync(new URL("../../../app/dashboard/page.tsx", import.meta.url), "utf8");
  const component = readFileSync(
    new URL("../../../components/dashboard/DashboardAutoRefresh.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /<DashboardAutoRefresh \/>/);
  assert.match(component, /"use client"/);
  assert.match(component, /createDashboardPoller\(\{ refresh: \(\) => router\.refresh\(\) \}\)/);
  assert.match(component, /poller\.start\(\)/);
  assert.match(component, /return \(\) => poller\.stop\(\)/);
  assert.match(component, /useEffect/);
});
