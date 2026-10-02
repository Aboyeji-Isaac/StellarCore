import assert from "node:assert/strict";
import test from "node:test";

import { AnchorStatus } from "@/app/generated/prisma/enums";
import {
  syncAnchorRegistry,
  type AnchorSyncDependencies,
  type PersistedAnchor,
} from "@/lib/stellar/anchorSync";
import { Sep1DiscoveryError } from "@/lib/stellar/sep1";
import type {
  AnchorRegistryEntry,
  DiscoveredAnchor,
} from "@/types/anchor";
import type { AnchorEvidenceOutcome } from "@/types/anchorHealth";

const MONEYGRAM = Object.freeze({
  slug: "moneygram",
  name: "MoneyGram",
  homeDomain: "mgxanchor.moneygram.com",
}) satisfies AnchorRegistryEntry;

const COWRIE = Object.freeze({
  slug: "cowrie",
  name: "Cowrie",
  homeDomain: "cowrie.exchange",
}) satisfies AnchorRegistryEntry;

test("a successful discovery is persisted and reported", async () => {
  const persisted: string[] = [];
  const dependencies = createDependencies({
    persist: async (anchor) => {
      persisted.push(anchor.slug);
      return toPersisted(anchor);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.deepEqual(persisted, ["moneygram"]);
  assert.deepEqual(result, {
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    successfulSlugs: ["moneygram"],
    failures: [],
    transitions: [],
  });
});

test("repeated synchronization upserts by slug without duplicates", async () => {
  const rows = new Map<string, PersistedAnchor>();
  const dependencies = createDependencies({
    persist: async (anchor) => {
      const persisted = toPersisted(anchor);
      rows.set(anchor.slug, persisted);
      return persisted;
    },
  });

  await syncAnchorRegistry([MONEYGRAM], dependencies);
  await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(rows.size, 1);
  assert.equal(rows.get("moneygram")?.status, AnchorStatus.LIVE);
});

test("one discovery failure does not prevent another anchor succeeding", async () => {
  const dependencies = createDependencies({
    discover: async (entry) => {
      if (entry.slug === "moneygram") {
        throw new Sep1DiscoveryError(
          "TIMEOUT",
          "safe timeout",
          "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
        );
      }

      return makeDiscovered(entry);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM, COWRIE], dependencies);

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.successfulSlugs, ["cowrie"]);
  assert.deepEqual(result.failures, [
    {
      slug: "moneygram",
      phase: "DISCOVERY",
      code: "TIMEOUT",
      statusUpdate: "RECORDED_EVIDENCE",
    },
  ]);
  assert.deepEqual(result.transitions, []);
});

test("one transient timeout never publishes DOWN for a previously healthy anchor", async () => {
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, toPersisted(makeDiscovered(MONEYGRAM))],
  ]);
  const dependencies = createDependencies({
    discover: async () => {
      throw new Sep1DiscoveryError(
        "TIMEOUT",
        "safe timeout",
        "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      );
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(result.failures[0]?.statusUpdate, "RECORDED_EVIDENCE");
  assert.equal(rows.get(MONEYGRAM.slug)?.status, AnchorStatus.LIVE);
  assert.deepEqual(result.transitions, []);
});

test("repeated transient failures escalate deterministically to DOWN", async () => {
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, toPersisted(makeDiscovered(MONEYGRAM))],
  ]);
  const { recordFailure } = createLedgeredRecorders(rows);
  const dependencies = createDependencies({
    discover: async () => {
      throw new Sep1DiscoveryError(
        "NETWORK_FAILURE",
        "safe network failure",
        "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      );
    },
    recordFailure,
  });

  const first = await syncAnchorRegistry([MONEYGRAM], dependencies);
  const second = await syncAnchorRegistry([MONEYGRAM], dependencies);
  const third = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(first.failures[0]?.statusUpdate, "RECORDED_EVIDENCE");
  assert.equal(second.failures[0]?.statusUpdate, "PUBLISHED_DEGRADED");
  assert.equal(third.failures[0]?.statusUpdate, "PUBLISHED_DOWN");
  assert.deepEqual(third.transitions, [
    { slug: MONEYGRAM.slug, status: AnchorStatus.DOWN, statusChanged: true },
  ]);
});

test("a flapping endpoint never toggles between LIVE and DOWN", async () => {
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, toPersisted(makeDiscovered(MONEYGRAM))],
  ]);
  const { recordSuccess, recordFailure } = createLedgeredRecorders(rows);
  let failing = false;
  const observedStatuses: AnchorStatus[] = [
    rows.get(MONEYGRAM.slug)!.status,
  ];

  const dependencies = createDependencies({
    discover: async () => {
      if (failing) {
        throw new Sep1DiscoveryError(
          "TIMEOUT",
          "safe timeout",
          "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
        );
      }
      return makeDiscovered(MONEYGRAM);
    },
    persist: persistPreservingStatus(rows),
    recordSuccess,
    recordFailure,
  });

  // failure -> success -> failure -> success: the published status never
  // reaches DOWN because neither evidence class accumulates.
  for (const cycle of [1, 2]) {
    failing = true;
    const failed = await syncAnchorRegistry([MONEYGRAM], dependencies);
    observedStatuses.push(rows.get(MONEYGRAM.slug)!.status);
    assert.equal(failed.failures[0]?.statusUpdate, "RECORDED_EVIDENCE");

    failing = false;
    await syncAnchorRegistry([MONEYGRAM], dependencies);
    observedStatuses.push(rows.get(MONEYGRAM.slug)!.status);
    assert.ok(cycle > 0);
  }

  assert.deepEqual(observedStatuses, [
    AnchorStatus.LIVE,
    AnchorStatus.LIVE,
    AnchorStatus.LIVE,
    AnchorStatus.LIVE,
    AnchorStatus.LIVE,
  ]);
});

test("successful recovery from DOWN is deterministic and evidence-based", async () => {
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, { ...toPersisted(makeDiscovered(MONEYGRAM)), status: AnchorStatus.DOWN }],
  ]);
  const { recordSuccess, recordFailure } = createLedgeredRecorders(rows);
  const dependencies = createDependencies({
    persist: persistPreservingStatus(rows),
    recordSuccess,
    recordFailure,
  });

  // Seed the failure side of the ledger so recovery thresholds are exercised.
  const seededFailure = await recordFailure(MONEYGRAM.slug, "TRANSIENT", "TIMEOUT");
  assert.equal(seededFailure.kind, "RECORDED");

  const first = await syncAnchorRegistry([MONEYGRAM], dependencies);
  assert.equal(rows.get(MONEYGRAM.slug)?.status, AnchorStatus.DEGRADED);
  assert.deepEqual(first.transitions, [
    { slug: MONEYGRAM.slug, status: AnchorStatus.DEGRADED, statusChanged: true },
  ]);

  const second = await syncAnchorRegistry([MONEYGRAM], dependencies);
  assert.equal(rows.get(MONEYGRAM.slug)?.status, AnchorStatus.LIVE);
  assert.deepEqual(second.transitions, [
    { slug: MONEYGRAM.slug, status: AnchorStatus.LIVE, statusChanged: true },
  ]);
});

test("protocol/configuration failures are classified separately and escalate faster", async () => {
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, toPersisted(makeDiscovered(MONEYGRAM))],
  ]);
  const { recordFailure } = createLedgeredRecorders(rows);
  const dependencies = createDependencies({
    discover: async () => {
      throw new Sep1DiscoveryError(
        "INVALID_TOML",
        "safe invalid TOML",
        "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      );
    },
    recordFailure,
  });

      if (!existing) return "NOT_FOUND";

      rows.set(slug, Object.freeze({ ...existing, status: AnchorStatus.DOWN }));
      return "MARKED_DOWN";
    },
    recordFailure,
  });

  const first = await syncAnchorRegistry([MONEYGRAM], dependencies);
  assert.equal(first.failures[0]?.code, "UNEXPECTED_ERROR");
  assert.equal(first.failures[0]?.statusUpdate, "RECORDED_EVIDENCE");

  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("DATABASE_URL"), false);
  assert.equal(serialized.includes("do-not-expose"), false);

  const second = await syncAnchorRegistry([MONEYGRAM], dependencies);
  assert.equal(second.failures[0]?.statusUpdate, "PUBLISHED_DEGRADED");
});

test("egress-policy rejection is not recorded as anchor downtime", async () => {
  let markDownCalls = 0;
  const result = await syncAnchorRegistry([MONEYGRAM], {
    discover: async () => {
      throw new Sep1DiscoveryError(
        "EGRESS_POLICY",
        "blocked by policy",
        "https://anchor.example/.well-known/stellar.toml",
      );
    },
    allocateOrder: async () => BigInt(1),
    persist: async () => {
      throw new Error("must not persist");
    },
    markDown: async () => {
      markDownCalls += 1;
      return "MARKED_DOWN";
    },
  });

  assert.equal(markDownCalls, 0);
  assert.equal(result.failures[0]?.code, "EGRESS_POLICY");
  assert.equal(result.failures[0]?.statusUpdate, "NOT_ATTEMPTED");
});

test("structured failures omit unsafe error details", async () => {
  const dependencies = createDependencies({
    discover: async () => {
      throw new Error("DATABASE_URL=do-not-expose");
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(result.failures[0]?.code, "UNEXPECTED_ERROR");
  assert.equal(JSON.stringify(result).includes("do-not-expose"), false);
});

test("late older discovery is rejected after a newer synchronization commits", async () => {
  let nextOrder = BigInt(0);
  let discoveryCalls = 0;
  let releaseOld!: () => void;
  const oldReady = new Promise<void>((resolve) => { releaseOld = resolve; });
  let row: { order: bigint; anchor: DiscoveredAnchor } | undefined;
  const dependencies = createDependencies({
    allocateOrder: async () => ++nextOrder,
    discover: async (entry) => {
      const call = ++discoveryCalls;
      if (call === 1) await oldReady;
      return Object.freeze({ ...makeDiscovered(entry), name: call === 1 ? "Old discovery" : "New discovery" });
    },
    persist: async (anchor, order) => {
      if (row && row.order >= order) return null;
      row = { order, anchor };
      return toPersisted(anchor);
    },
  });

  const older = syncAnchorRegistry([MONEYGRAM], dependencies);
  await Promise.resolve();
  const newer = await syncAnchorRegistry([MONEYGRAM], dependencies);
  releaseOld();
  const olderResult = await older;

  assert.equal(row?.anchor.name, "New discovery");
  assert.equal(newer.succeeded, 1);
  assert.equal(olderResult.failures[0]?.code, "STALE_WRITE_REJECTED");
});

test("late older discovery failure cannot downgrade a newer successful synchronization", async () => {
  let nextOrder = BigInt(0);
  let releaseOld!: () => void;
  const oldReady = new Promise<void>((resolve) => { releaseOld = resolve; });
  let row: { order: bigint; status: AnchorStatus } = { order: BigInt(0), status: AnchorStatus.DOWN };
  const dependencies = createDependencies({
    allocateOrder: async () => ++nextOrder,
    discover: async (entry) => {
      if (nextOrder === BigInt(1)) {
        await oldReady;
        throw new Sep1DiscoveryError("TIMEOUT", "safe timeout", "https://example.com/stellar.toml");
      }
      return makeDiscovered(entry);
    },
    persist: async (anchor, order) => {
      if (order > row.order) row = { order, status: AnchorStatus.LIVE };
      return order === row.order ? toPersisted(anchor) : null;
    },
    markDown: async (_slug, order) => {
      if (order <= row.order) return "STALE";
      row = { order, status: AnchorStatus.DOWN };
      return "MARKED_DOWN";
    },
  });

  const older = syncAnchorRegistry([MONEYGRAM], dependencies);
  await Promise.resolve();
  await syncAnchorRegistry([MONEYGRAM], dependencies);
  releaseOld();
  const olderResult = await older;

  assert.equal(row.status, AnchorStatus.LIVE);
  assert.equal(olderResult.failures[0]?.statusUpdate, "STALE");
});

test("unexpected persistence errors are isolated from later anchors", async () => {
  const dependencies = createDependencies({
    persist: async (anchor) => {
      if (anchor.slug === "moneygram") throw new Error("database unavailable");
      return toPersisted(anchor);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM, COWRIE], dependencies);

  assert.deepEqual(result.successfulSlugs, ["cowrie"]);
  assert.deepEqual(result.failures, [
    {
      slug: "moneygram",
      phase: "PERSISTENCE",
      code: "PERSISTENCE_FAILURE",
      statusUpdate: "NOT_ATTEMPTED",
    },
  ]);
  // A persistence failure is never anchor health evidence.
  assert.deepEqual(result.transitions, []);
});

test("evidence recording survives a fresh process: state is rebuilt from persisted rows", async () => {
  // This test simulates a process restart: the ledger stands in for the
  // persisted health row and each worker builds fresh dependency objects,
  // exactly like a restarted worker re-reading persisted state.
  const ledger: HealthLedger = new Map();
  const rows = new Map<string, PersistedAnchor>([
    [MONEYGRAM.slug, toPersisted(makeDiscovered(MONEYGRAM))],
  ]);

  const failingDiscovery = async () => {
    throw new Sep1DiscoveryError(
      "TIMEOUT",
      "safe timeout",
      "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
    );
  };

  const firstWorker = createDependencies({
    discover: failingDiscovery,
    recordFailure: recordingRecordFailure(rows, ledger),
  });

  await syncAnchorRegistry([MONEYGRAM], firstWorker);
  await syncAnchorRegistry([MONEYGRAM], firstWorker);
  assert.equal(rows.get(MONEYGRAM.slug)?.status, AnchorStatus.DEGRADED);

  // A "restarted" worker reconstructs its in-memory view from the same
  // persisted ledger and continues the escalation deterministically.
  const restartedWorker = createDependencies({
    discover: failingDiscovery,
    recordFailure: recordingRecordFailure(rows, ledger),
  });

  await syncAnchorRegistry([MONEYGRAM], restartedWorker);
  assert.equal(rows.get(MONEYGRAM.slug)?.status, AnchorStatus.DOWN);
});

test("failure evidence for an unknown anchor is reported without a transition", async () => {
  const dependencies = createDependencies({
    discover: async () => {
      throw new Sep1DiscoveryError(
        "TIMEOUT",
        "safe timeout",
        "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      );
    },
    recordFailure: async () => ({ kind: "ANCHOR_NOT_FOUND" }),
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(result.failures[0]?.statusUpdate, "ANCHOR_NOT_FOUND");
  assert.deepEqual(result.transitions, []);
});

function createDependencies(
  overrides: Partial<AnchorSyncDependencies> = {},
): AnchorSyncDependencies {
  const successes = new Map<string, number>();
  const failures = new Map<string, number>();

  return {
    allocateOrder: async () => BigInt(1),
    discover: async (entry) => makeDiscovered(entry),
    persist: async (anchor) => toPersisted(anchor),
    markDown: async () => "NOT_FOUND",
    ...overrides,
  };
}

type HealthLedger = Map<string, { consecutiveFailures: number; consecutiveSuccesses: number; status: AnchorStatus }>;

/**
 * Test double for the persistence boundary. It mirrors the documented
 * thresholds and shares one ledger between success and failure recorders so
 * success resets the consecutive-failure counter, like the real state row.
 */
function createLedgeredRecorders(rows: Map<string, PersistedAnchor>) {
  const ledger: HealthLedger = new Map();

  const recordFailure = recordingRecordFailure(rows, ledger);
  const recordSuccess = async (
    slug: string,
  ): Promise<AnchorEvidenceOutcome> => {
    const row = rows.get(slug);

    if (!row) return { kind: "ANCHOR_NOT_FOUND" };

    const entry = ledger.get(slug) ?? {
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      status: row.status,
    };
    entry.consecutiveFailures = 0;
    entry.consecutiveSuccesses += 1;
    entry.status = row.status;
    ledger.set(slug, entry);

    // Recovery evidence: DOWN/DEGRADED with one success publishes DEGRADED,
    // the second success publishes LIVE, mirroring the real thresholds.
    let status = row.status;
    let statusChanged = false;
    if (status === AnchorStatus.DOWN || status === AnchorStatus.DEGRADED) {
      status = entry.consecutiveSuccesses >= 2
        ? AnchorStatus.LIVE
        : AnchorStatus.DEGRADED;
      statusChanged = status !== row.status;
      rows.set(slug, Object.freeze({ ...row, status }));
      entry.status = status;
    }

    return { kind: "RECORDED", status, statusChanged };
  };

  return { recordSuccess, recordFailure, ledger };
}

function recordingRecordFailure(
  rows: Map<string, PersistedAnchor>,
  ledger: HealthLedger,
) {
  return async (
    slug: string,
    failureClass: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _failureCode: string,
  ): Promise<AnchorEvidenceOutcome> => {
    const row = rows.get(slug);

    if (!row) return { kind: "ANCHOR_NOT_FOUND" };

    const entry = ledger.get(slug) ?? {
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      status: row.status,
    };
    entry.consecutiveFailures += 1;
    entry.consecutiveSuccesses = 0;

    // Mirror the documented thresholds: transient escalates at 2/3,
    // deterministic at the second failure.
    let status = entry.status;
    if (status !== AnchorStatus.DOWN) {
      if (failureClass === "DETERMINISTIC") {
        if (entry.consecutiveFailures >= 2) status = AnchorStatus.DOWN;
        else status = AnchorStatus.DEGRADED;
      } else {
        if (entry.consecutiveFailures >= 3) status = AnchorStatus.DOWN;
        else if (entry.consecutiveFailures >= 2) status = AnchorStatus.DEGRADED;
        else status = entry.status === AnchorStatus.UNKNOWN
          ? AnchorStatus.UNKNOWN
          : entry.status;
      }
    }

    const statusChanged = status !== row.status;
    entry.status = status;
    ledger.set(slug, entry);

    rows.set(slug, Object.freeze({ ...row, status }));

    return { kind: "RECORDED", status, statusChanged };
  };
}

/** Persists metadata while preserving the row's published status, like the real upsert. */
function persistPreservingStatus(rows: Map<string, PersistedAnchor>) {
  return async (anchor: DiscoveredAnchor): Promise<PersistedAnchor> => {
    const existing = rows.get(anchor.slug);
    const persisted = toPersisted(anchor);
    const merged = Object.freeze({
      ...persisted,
      status: existing?.status ?? persisted.status,
    });
    rows.set(anchor.slug, merged);
    return merged;
  };
}

function makeDiscovered(entry: AnchorRegistryEntry): DiscoveredAnchor {
  return Object.freeze({
    ...entry,
    tomlUrl: `https://${entry.homeDomain}/.well-known/stellar.toml`,
    organizationName: entry.name,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    seps: Object.freeze([1, 10, 24] as const),
    isTransferCapable: true,
    endpoints: Object.freeze({}),
    assets: Object.freeze([]),
  });
}

function toPersisted(anchor: DiscoveredAnchor): PersistedAnchor {
  return Object.freeze({
    slug: anchor.slug,
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    tomlUrl: anchor.tomlUrl,
    seps: Object.freeze([...anchor.seps]),
    isTransferCapable: anchor.isTransferCapable,
    status: AnchorStatus.LIVE,
  });
}
