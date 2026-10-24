import assert from "node:assert/strict";
import test from "node:test";

import { createPanelRequestState } from "@/lib/ui/panelRequestState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function overlappingRequests() {
  const panel = createPanelRequestState("initial evidence");
  const older = deferred<string>();
  const newer = deferred<string>();
  const olderDone = panel.refresh(() => older.promise);
  const newerDone = panel.refresh(() => newer.promise);
  assert.deepEqual(panel.getSnapshot(), { data: "initial evidence", loading: true, error: null });
  return { panel, older, newer, olderDone, newerDone };
}

test("an older response cannot overwrite a newer completed refresh", async () => {
  const { panel, older, newer, olderDone, newerDone } = overlappingRequests();
  newer.resolve("newer evidence");
  await newerDone;
  assert.deepEqual(panel.getSnapshot(), { data: "newer evidence", loading: false, error: null });
  const settled = panel.getSnapshot();
  older.resolve("older evidence");
  await olderDone;
  assert.equal(panel.getSnapshot(), settled);
});

test("an obsolete rejection cannot surface as the current panel error", async () => {
  const { panel, older, newer, olderDone, newerDone } = overlappingRequests();
  newer.resolve("newer evidence");
  await newerDone;
  const settled = panel.getSnapshot();
  older.reject(new Error("obsolete failure"));
  await olderDone;
  assert.equal(panel.getSnapshot(), settled);
});

for (const outcome of ["success", "failure"] as const) {
  test(`obsolete ${outcome} cannot settle loading while the active request is pending`, async () => {
    const { panel, older, newer, olderDone, newerDone } = overlappingRequests();
    const pending = panel.getSnapshot();
    if (outcome === "success") older.resolve("older evidence");
    else older.reject(new Error("obsolete failure"));
    await olderDone;
    assert.equal(panel.getSnapshot(), pending);
    newer.resolve("newer evidence");
    await newerDone;
    assert.deepEqual(panel.getSnapshot(), { data: "newer evidence", loading: false, error: null });
  });
}

test("the active rejection settles loading and cannot be hidden by an older success", async () => {
  const { panel, older, newer, olderDone, newerDone } = overlappingRequests();
  newer.reject(new Error("current failure"));
  await newerDone;
  assert.deepEqual(panel.getSnapshot(), { data: "initial evidence", loading: false, error: "current failure" });
  const failed = panel.getSnapshot();
  older.resolve("older evidence");
  await olderDone;
  assert.equal(panel.getSnapshot(), failed);
  await panel.refresh(async () => {
    assert.deepEqual(panel.getSnapshot(), { data: "initial evidence", loading: true, error: null });
    return "recovered evidence";
  });
  assert.deepEqual(panel.getSnapshot(), { data: "recovered evidence", loading: false, error: null });
});

test("request identity distinguishes three refreshes even when revisiting the same selection", async () => {
  const { panel, older, newer, olderDone, newerDone } = overlappingRequests();
  const latest = deferred<string>();
  const latestDone = panel.refresh(() => latest.promise);
  newer.resolve("middle evidence");
  await newerDone;
  assert.equal(panel.getSnapshot().loading, true);
  latest.resolve("latest evidence for original selection");
  await latestDone;
  older.resolve("old evidence for original selection");
  await olderDone;
  assert.deepEqual(panel.getSnapshot(), { data: "latest evidence for original selection", loading: false, error: null });
});

test("synchronous loader failures also settle the active request", async () => {
  const panel = createPanelRequestState("initial evidence");
  await panel.refresh(() => { throw new Error("loader failed"); });
  assert.deepEqual(panel.getSnapshot(), { data: "initial evidence", loading: false, error: "loader failed" });
  await panel.refresh(() => Promise.reject("unexpected rejection"));
  assert.equal(panel.getSnapshot().error, "Unable to load data.");
});

for (const outcome of ["success", "failure"] as const) {
  test(`cancelled ${outcome} cannot publish to an unmounted panel`, async () => {
    const panel = createPanelRequestState("initial evidence");
    const pending = deferred<string>();
    let notifications = 0;
    const unsubscribe = panel.subscribe(() => { notifications += 1; });
    const done = panel.refresh(() => pending.promise);
    panel.cancel();
    const cancelled = panel.getSnapshot();
    assert.equal(cancelled.loading, false);
    assert.equal(notifications, 2);
    unsubscribe();
    if (outcome === "success") pending.resolve("late evidence");
    else pending.reject(new Error("late failure"));
    await done;
    assert.equal(panel.getSnapshot(), cancelled);
    assert.equal(notifications, 2);
    await panel.refresh(async () => "remounted evidence");
    assert.equal(panel.getSnapshot().data, "remounted evidence");
    assert.equal(notifications, 2);
  });
}
