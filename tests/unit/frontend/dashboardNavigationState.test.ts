import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DashboardPanelCoordinator,
  type DashboardPanelSnapshot,
} from "@/lib/dashboard/dashboardNavigationState";

/** Helper to create a deferred promise for precise timing control. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type TestRateData = { rate: string; timestamp: string };

test("obsolete in-flight request does not update inactive view after navigating away", async () => {
  const coordinator = new DashboardPanelCoordinator<TestRateData>({
    cachePolicy: "network-first",
  });
  const deferred1 = createDeferred<TestRateData>();
  const snapshots: DashboardPanelSnapshot<TestRateData>[] = [];

  const unsubscribe = coordinator.subscribe((snap) => {
    snapshots.push(snap);
  });

  // User navigates to dashboard
  const fetchPromise = coordinator.navigateIn(() => deferred1.promise);

  assert.equal(coordinator.getSnapshot().status, "loading");
  assert.equal(coordinator.getSnapshot().isActive, true);

  // User navigates away before request completes
  coordinator.navigateAway();
  assert.equal(coordinator.getSnapshot().isActive, false);

  const snapshotCountAtNavAway = snapshots.length;

  // Deferred response resolves while view is inactive
  deferred1.resolve({ rate: "5.10", timestamp: "2026-10-21T12:00:00Z" });
  await fetchPromise;

  // Verify view was not updated unexpectedly
  assert.equal(coordinator.getSnapshot().data, null);
  assert.equal(coordinator.getSnapshot().status, "loading");
  assert.equal(coordinator.getSnapshot().isActive, false);

  // No further snapshot notifications delivered to inactive view
  assert.equal(snapshots.length, snapshotCountAtNavAway);

  unsubscribe();
});

test("slow obsolete request from prior visit cannot overwrite newer data from subsequent visit", async () => {
  const coordinator = new DashboardPanelCoordinator<TestRateData>();
  const deferred1 = createDeferred<TestRateData>();
  const deferred2 = createDeferred<TestRateData>();

  // Visit 1: navigate to dashboard
  const fetch1 = coordinator.navigateIn(() => deferred1.promise);

  // User navigates away
  coordinator.navigateAway();

  // Visit 2: user navigates back to dashboard
  const fetch2 = coordinator.navigateIn(() => deferred2.promise);
  assert.equal(coordinator.getSnapshot().visitCount, 2);

  // Request 2 completes with fresh data
  deferred2.resolve({ rate: "5.50", timestamp: "2026-10-21T12:05:00Z" });
  await fetch2;

  assert.equal(coordinator.getSnapshot().status, "success");
  assert.equal(coordinator.getSnapshot().data?.rate, "5.50");

  // Late deferred response from Visit 1 resolves with older data
  deferred1.resolve({ rate: "4.80", timestamp: "2026-10-21T12:00:00Z" });
  await fetch1;

  // View state must NOT be overwritten by the obsolete request
  assert.equal(coordinator.getSnapshot().status, "success");
  assert.equal(coordinator.getSnapshot().data?.rate, "5.50");
});

test("pending failure after navigating away does not poison next view visit", async () => {
  const coordinator = new DashboardPanelCoordinator<TestRateData>();
  const deferred1 = createDeferred<TestRateData>();
  const deferred2 = createDeferred<TestRateData>();

  // Visit 1 starts
  const fetch1 = coordinator.navigateIn(() => deferred1.promise);

  // Navigate away while pending
  coordinator.navigateAway();

  // Request 1 fails while view is inactive
  deferred1.reject(new Error("504 Gateway Timeout"));
  await fetch1;

  // Inactive view did not transition to error
  assert.equal(coordinator.getSnapshot().error, null);

  // Visit 2: user returns to dashboard
  const fetch2 = coordinator.navigateIn(() => deferred2.promise);
  assert.equal(coordinator.getSnapshot().status, "loading");

  // Request 2 resolves cleanly
  deferred2.resolve({ rate: "5.25", timestamp: "2026-10-21T12:10:00Z" });
  await fetch2;

  assert.equal(coordinator.getSnapshot().status, "success");
  assert.equal(coordinator.getSnapshot().data?.rate, "5.25");
  assert.equal(coordinator.getSnapshot().error, null);
});

test("loading and error states remain consistent during rapid navigations", async () => {
  const coordinator = new DashboardPanelCoordinator<TestRateData>();
  const deferredRequests: ReturnType<typeof createDeferred<TestRateData>>[] = [];

  // Simulate user rapidly navigating in, out, in, out, in
  for (let i = 0; i < 3; i++) {
    const d = createDeferred<TestRateData>();
    deferredRequests.push(d);
    void coordinator.navigateIn(() => d.promise);
    if (i < 2) {
      coordinator.navigateAway();
    }
  }

  // Active view is currently on visit 3
  assert.equal(coordinator.getSnapshot().visitCount, 3);
  assert.equal(coordinator.getSnapshot().status, "loading");
  assert.equal(coordinator.getSnapshot().isActive, true);

  // Out of order resolution: resolve visit 1 then visit 2
  deferredRequests[0]!.resolve({ rate: "1.00", timestamp: "2026-10-21T12:00:00Z" });
  deferredRequests[1]!.reject(new Error("Interrupted"));
  await Promise.resolve();

  // State is still loading for visit 3
  assert.equal(coordinator.getSnapshot().status, "loading");
  assert.equal(coordinator.getSnapshot().data, null);
  assert.equal(coordinator.getSnapshot().error, null);

  // Finally active visit 3 resolves
  deferredRequests[2]!.resolve({ rate: "3.00", timestamp: "2026-10-21T12:02:00Z" });
  await Promise.resolve();

  assert.equal(coordinator.getSnapshot().status, "success");
  assert.equal(coordinator.getSnapshot().data?.rate, "3.00");
});

test("subscriptions are cleanly managed without leaks or duplication across navigations", async () => {
  const coordinator = new DashboardPanelCoordinator<TestRateData>();
  assert.equal(coordinator.activeSubscriptionCount, 0);

  // Component mounts on visit 1
  let unmount1: (() => void) | null = coordinator.subscribe(() => {});
  assert.equal(coordinator.activeSubscriptionCount, 1);

  // Component unmounts on navigation away
  unmount1();
  unmount1 = null;
  coordinator.navigateAway();
  assert.equal(coordinator.activeSubscriptionCount, 0);

  // Component remounts on return (visit 2)
  let unmount2: (() => void) | null = coordinator.subscribe(() => {});
  assert.equal(coordinator.activeSubscriptionCount, 1);

  // Component unmounts again
  unmount2();
  unmount2 = null;
  coordinator.navigateAway();
  assert.equal(coordinator.activeSubscriptionCount, 0);
});

test("cache-first policy reuses fresh data without issuing duplicate network requests", async () => {
  let fetchCount = 0;
  const coordinator = new DashboardPanelCoordinator<TestRateData>({
    cachePolicy: "cache-first",
    cacheTtlMs: 30_000,
  });

  const fetcher = async () => {
    fetchCount += 1;
    return { rate: "5.00", timestamp: "2026-10-21T12:00:00Z" };
  };

  // Visit 1 at t=1000
  await coordinator.navigateIn(fetcher, 1_000);
  assert.equal(fetchCount, 1);
  assert.equal(coordinator.getSnapshot().status, "success");

  // User navigates away
  coordinator.navigateAway();

  // User navigates back at t=5000 (within 30s cache TTL)
  await coordinator.navigateIn(fetcher, 5_000);
  assert.equal(fetchCount, 1, "Must reuse cached data without duplicate fetch");
  assert.equal(coordinator.getSnapshot().status, "success");
  assert.equal(coordinator.getSnapshot().data?.rate, "5.00");

  // User navigates back after cache expiry at t=40000 (> 30s)
  await coordinator.navigateIn(fetcher, 40_000);
  assert.equal(fetchCount, 2, "Must refresh expired cache on return");
});

test("component rendering reflects consistent view state across navigation lifecycle", () => {
  function MockPanelDisplay({ snapshot }: { snapshot: DashboardPanelSnapshot<TestRateData> }) {
    if (snapshot.status === "loading") {
      return createElement("div", { "data-testid": "panel-loading" }, "Loading evidence...");
    }
    if (snapshot.status === "error") {
      return createElement("div", { "data-testid": "panel-error" }, snapshot.error);
    }
    if (snapshot.status === "success" && snapshot.data) {
      return createElement("div", { "data-testid": "panel-data" }, `Rate: ${snapshot.data.rate}`);
    }
    return createElement("div", { "data-testid": "panel-idle" }, "Idle");
  }

  // 1. Initial idle
  const idleCoordinator = new DashboardPanelCoordinator<TestRateData>();
  const idleHtml = renderToStaticMarkup(
    createElement(MockPanelDisplay, { snapshot: idleCoordinator.getSnapshot() }),
  );
  assert.match(idleHtml, /data-testid="panel-idle"/);

  // 2. Loading state during pending request
  const loadingCoordinator = new DashboardPanelCoordinator<TestRateData>();
  void loadingCoordinator.navigateIn(() => new Promise(() => {}));
  const loadingHtml = renderToStaticMarkup(
    createElement(MockPanelDisplay, { snapshot: loadingCoordinator.getSnapshot() }),
  );
  assert.match(loadingHtml, /data-testid="panel-loading"/);

  // 3. Success state
  const successCoordinator = new DashboardPanelCoordinator<TestRateData>({
    initialData: { rate: "5.20", timestamp: "2026-10-21T12:00:00Z" },
  });
  const successHtml = renderToStaticMarkup(
    createElement(MockPanelDisplay, { snapshot: successCoordinator.getSnapshot() }),
  );
  assert.match(successHtml, /data-testid="panel-data"/);
  assert.match(successHtml, /Rate: 5\.20/);
});
