import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient } from "pg";

import {
  DatabaseDeadlineExceededError,
  withDatabaseDeadline,
} from "@/lib/db/deadlines";
import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunSummary,
} from "@/lib/reputation/run";
import { readInReputationSnapshot } from "@/lib/reputation/snapshot";
import {
  withAdvisoryLock,
  type AdvisoryLockClientDependencies,
} from "@/lib/scheduled/advisoryLockClient";
import { LOCK_REGISTRY } from "@/lib/scheduled/advisoryLockKey";
import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SuppressionRepository } from "@/lib/scheduled/suppressionRepository";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ReputationRepository } from "@/types/reputation";

/**
 * Scheduled-job timeout handling must release every database resource it
 * acquired (#386).
 *
 * The runtime model under test is the one the repository already ships:
 *
 * - `withDatabaseDeadline` (lib/db/deadlines.ts) bounds a database operation
 *   with a timeout and/or an `AbortSignal`. On expiry it aborts the
 *   operation's signal so the in-flight work can be cancelled.
 * - `withAdvisoryLock` (lib/scheduled/advisoryLockClient.ts) holds a
 *   session-scoped PostgreSQL advisory lock on a checked-out pool client and
 *   releases both the lock and the client when the body settles.
 * - `runScheduledRefresh` (lib/scheduled/refresh.ts) is the scheduler cycle:
 *   rate-phase failures are isolated into the run summary, reputation-phase
 *   failures propagate to the HTTP boundary.
 * - `readInReputationSnapshot` (lib/reputation/snapshot.ts) reads the
 *   scheduled evidence set inside one bounded interactive transaction, so the
 *   driver rolls the transaction back when the bound is exceeded.
 *
 * Every scenario below is driven by a cancelled/aborted signal or by a
 * millisecond-scale deadline: no test waits on wall-clock time and no test
 * needs a live database, a live anchor, or the network.
 */

const NOW = new Date("2026-08-31T16:00:00.000Z");

const REFRESH_LOCK = LOCK_REGISTRY.find(
  (entry) => entry.logicalName === "refresh:scheduled-refresh:v1:global",
)!;

const ACQUIRE_LOCK_SQL = "SELECT PG_TRY_ADVISORY_LOCK($1::BIGINT) AS ACQUIRED";
const RELEASE_LOCK_SQL = "SELECT PG_ADVISORY_UNLOCK($1::BIGINT)";

// ---------------------------------------------------------------------------
// In-memory PostgreSQL double
// ---------------------------------------------------------------------------

type QueryResult = { rows: Array<Record<string, unknown>> };

type Session = {
  readonly id: number;
  inTransaction: boolean;
  stagedRows: string[];
  readonly heldLocks: Set<string>;
  pendingRejects: Array<(reason: Error) => void>;
};

type FakeScheduledDatabase = {
  /** Ordered lifecycle log: `checkout:<id>`, `query:<id>:<sql>`, `release:<id>`. */
  readonly events: string[];
  /** Rows that reached durable storage (committed transactions only). */
  readonly committedRows: string[];
  readonly max: number;
  readonly checkedOutCount: () => number;
  readonly idleCount: () => number;
  readonly peakCheckedOutCount: () => number;
  readonly lockHolders: () => number;
  readonly openTransactions: () => number;
  readonly cancelledQueries: () => number;
  readonly setSourceAvailable: (available: boolean) => void;
  readonly waitForSourceQuery: () => Promise<void>;
  readonly checkout: () => Promise<PoolClient>;
  readonly release: (client: PoolClient) => void;
  readonly cancelPendingQueries: (client: PoolClient, reason: Error) => void;
  readonly isInTransaction: (client: PoolClient) => boolean;
};

/**
 * A small PostgreSQL double that models only what the scheduled-job timeout
 * contract depends on: a bounded pool of sessions, session-scoped advisory
 * locks, explicit transactions with staged rows, and a source query that only
 * completes when it is cancelled.
 *
 * Session state survives a release, exactly like a pooled PostgreSQL
 * connection: a session that is returned to the pool without an explicit
 * `ROLLBACK` keeps its open transaction, and a session that is returned
 * without `pg_advisory_unlock` keeps its lock. That is what makes a missing
 * cleanup observable here.
 */
function fakeScheduledDatabase(options: { max?: number } = {}): FakeScheduledDatabase {
  const max = options.max ?? 2;
  const events: string[] = [];
  const committedRows: string[] = [];
  const sessions: Session[] = [];
  const idle: Session[] = [];
  const clientSessions = new WeakMap<object, Session>();
  let checkedOut = 0;
  let peakCheckedOut = 0;
  let cancelledQueries = 0;
  let sourceAvailable = true;
  let sourceQueryCount = 0;
  let sourceQueryWaiters: Array<() => void> = [];

  function notifySourceQueryStarted(): void {
    sourceQueryCount += 1;
    const waiters = sourceQueryWaiters;
    sourceQueryWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function createSession(): Session {
    if (sessions.length >= max) {
      throw new Error("connection pool exhausted");
    }
    const session: Session = {
      id: sessions.length + 1,
      inTransaction: false,
      stagedRows: [],
      heldLocks: new Set<string>(),
      pendingRejects: [],
    };
    sessions.push(session);
    return session;
  }

  function runQuery(
    session: Session,
    sql: string,
    params: readonly unknown[],
  ): Promise<QueryResult> {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    events.push(`query:${session.id}:${normalized}`);

    if (normalized.startsWith("SELECT PG_TRY_ADVISORY_LOCK")) {
      const key = String(params[0] ?? "");
      const heldElsewhere = sessions.some(
        (other) => other !== session && other.heldLocks.has(key),
      );
      const acquired = session.heldLocks.has(key) || !heldElsewhere;
      if (acquired) session.heldLocks.add(key);
      return Promise.resolve({ rows: [{ acquired }] });
    }

    if (normalized.startsWith("SELECT PG_ADVISORY_UNLOCK")) {
      const key = String(params[0] ?? "");
      const unlocked = session.heldLocks.delete(key);
      return Promise.resolve({ rows: [{ pg_advisory_unlock: unlocked }] });
    }

    if (normalized === "BEGIN") {
      session.inTransaction = true;
      return Promise.resolve({ rows: [] });
    }

    if (normalized === "COMMIT") {
      committedRows.push(...session.stagedRows);
      session.stagedRows = [];
      session.inTransaction = false;
      return Promise.resolve({ rows: [] });
    }

    if (normalized === "ROLLBACK") {
      session.stagedRows = [];
      session.inTransaction = false;
      return Promise.resolve({ rows: [] });
    }

    if (normalized.startsWith("INSERT INTO RATE_SNAPSHOTS")) {
      session.stagedRows.push(String(params[0] ?? ""));
      return Promise.resolve({ rows: [] });
    }

    if (normalized.startsWith("SELECT * FROM RATE_SOURCES")) {
      notifySourceQueryStarted();
      if (sourceAvailable) {
        return Promise.resolve({ rows: [{ slug: String(params[0] ?? "") }] });
      }
      return new Promise<QueryResult>((_resolve, reject) => {
        session.pendingRejects.push(reject);
      });
    }

    return Promise.resolve({ rows: [] });
  }

  function releaseSession(session: Session): void {
    events.push(`release:${session.id}`);
    checkedOut -= 1;
    idle.push(session);
  }

  function sessionFor(client: PoolClient): Session | undefined {
    return clientSessions.get(client as unknown as object);
  }

  return {
    events,
    committedRows,
    max,
    checkedOutCount: () => checkedOut,
    idleCount: () => idle.length,
    peakCheckedOutCount: () => peakCheckedOut,
    lockHolders: () => sessions.filter((session) => session.heldLocks.size > 0).length,
    openTransactions: () => sessions.filter((session) => session.inTransaction).length,
    cancelledQueries: () => cancelledQueries,
    setSourceAvailable(available: boolean) {
      sourceAvailable = available;
    },
    async waitForSourceQuery() {
      if (sourceQueryCount > 0) return;
      await new Promise<void>((resolve) => {
        sourceQueryWaiters.push(resolve);
      });
    },
    async checkout() {
      const session = idle.pop() ?? createSession();
      events.push(`checkout:${session.id}`);
      checkedOut += 1;
      peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
      const client = {
        query: async (sql: string, params?: unknown[]) =>
          runQuery(session, sql, params ?? []),
        release: () => releaseSession(session),
      };
      clientSessions.set(client, session);
      return client as unknown as PoolClient;
    },
    release(client: PoolClient) {
      const session = sessionFor(client);
      if (!session) return;
      releaseSession(session);
    },
    cancelPendingQueries(client: PoolClient, reason: Error) {
      const session = sessionFor(client);
      if (!session) return;
      const pending = session.pendingRejects;
      session.pendingRejects = [];
      if (pending.length > 0) cancelledQueries += pending.length;
      for (const reject of pending) reject(reason);
    },
    isInTransaction(client: PoolClient) {
      return sessionFor(client)?.inTransaction === true;
    },
  };
}

function countEvents(events: readonly string[], prefix: string): number {
  return events.filter((event) => event.startsWith(prefix)).length;
}

/**
 * Waits for the job's cleanup, but never longer than the guard: a regression
 * that stops releasing a resource must fail the test instead of hanging the
 * suite. The guard never delays a passing test.
 */
async function settleWithin(run: JobRun, budgetMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the job never released its resources (${budgetMs}ms budget)`));
    }, budgetMs);
  });

  try {
    await Promise.race([run.settled, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The scheduled job under test
// ---------------------------------------------------------------------------

type JobOptions = Readonly<{
  /** Durable label written by the job; proves which run committed. */
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Error raised by the source handler when the job is cancelled. */
  handlerError?: Error;
}>;

type JobOutcome = Readonly<{
  lockAcquired: boolean;
  committed: boolean;
}>;

type JobRun = {
  /** Settles with the job result, or rejects with the timeout/cancellation. */
  readonly outcome: Promise<JobOutcome>;
  /** Settles once every acquired resource has been released. */
  readonly settled: Promise<void>;
};

/**
 * A scheduled, database-backed job built from the shipped primitives: it takes
 * the scheduled advisory lock, opens a transaction, writes a snapshot, reads
 * the rate source, and commits.
 *
 * The deadline (or the injected abort signal) is applied around the database
 * work with `withDatabaseDeadline`, so the source query is cancelled through
 * the operation's own `AbortSignal` — the only cancellation mechanism the
 * runtime model provides.
 */
function runScheduledJob(
  database: FakeScheduledDatabase,
  key: bigint,
  options: JobOptions,
): JobRun {
  const dependencies: AdvisoryLockClientDependencies = {
    checkoutClient: () => database.checkout(),
    releaseClient: (client) => database.release(client),
  };

  let operationSettled: Promise<void> = Promise.resolve();

  const operation = async (signal: AbortSignal): Promise<JobOutcome> => {
    const client = await database.checkout();
    const onAbort = () => {
      database.cancelPendingQueries(
        client,
        options.handlerError ?? new Error("source query cancelled"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal.aborted) throw new Error("operation aborted before it started");
      await client.query("BEGIN");
      await client.query("INSERT INTO rate_snapshots (label) VALUES ($1)", [
        options.label,
      ]);
      await client.query("SELECT * FROM rate_sources WHERE slug = $1", [
        options.label,
      ]);
      await client.query("COMMIT");
      return Object.freeze({ lockAcquired: true, committed: true });
    } catch (error) {
      if (database.isInTransaction(client)) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      database.release(client);
    }
  };

  const outcome = (async (): Promise<JobOutcome> => {
    const locked = await withAdvisoryLock(
      key,
      async () =>
        withDatabaseDeadline(
          (signal) => {
            const promise = operation(signal);
            operationSettled = promise.then(
              () => undefined,
              () => undefined,
            );
            return promise;
          },
          { timeoutMs: options.timeoutMs, signal: options.signal },
        ),
      dependencies,
    );

    if (!("result" in locked)) {
      return Object.freeze({ lockAcquired: false, committed: false });
    }
    return locked.result;
  })();

  const settled = (async () => {
    try {
      await outcome;
    } catch {
      // The failure itself is asserted through `outcome`; this only waits for
      // the cleanup that runs after the deadline rejected the operation.
    }
    await operationSettled;
  })();

  return { outcome, settled };
}

// ---------------------------------------------------------------------------
// Bounded termination
// ---------------------------------------------------------------------------

test("a scheduled job that exceeds its deadline is terminated within the bounded deadline", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    timeoutMs: 25,
  });

  const startedAt = Date.now();
  await assert.rejects(run.outcome, (error: unknown) => {
    assert.ok(error instanceof DatabaseDeadlineExceededError);
    assert.equal(error.code, "DATABASE_DEADLINE_EXCEEDED");
    assert.equal(error.timeoutMs, 25);
    return true;
  });
  const elapsed = Date.now() - startedAt;
  await settleWithin(run);

  assert.ok(
    elapsed < 1_000,
    `the deadline must bound the run instead of hanging, elapsed=${elapsed}ms`,
  );
  assert.equal(
    database.cancelledQueries(),
    1,
    "the in-flight source query must be cancelled through the abort signal",
  );
});

// ---------------------------------------------------------------------------
// Rollback of the open transaction
// ---------------------------------------------------------------------------

test("a timeout rolls back the open transaction so nothing is partially committed", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    timeoutMs: 25,
  });

  await assert.rejects(run.outcome);
  await settleWithin(run);

  assert.ok(
    database.events.includes("query:2:ROLLBACK"),
    `the open transaction must be rolled back, events=${database.events.join(" | ")}`,
  );
  assert.deepEqual(database.committedRows, []);
  assert.equal(database.openTransactions(), 0);
});

// ---------------------------------------------------------------------------
// Connection returned to the pool
// ---------------------------------------------------------------------------

test("a timeout returns every connection to the pool exactly once", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    timeoutMs: 25,
  });

  await assert.rejects(run.outcome);
  await settleWithin(run);

  assert.equal(database.checkedOutCount(), 0);
  assert.equal(database.idleCount(), 2);
  assert.equal(countEvents(database.events, "release:"), 2);
  assert.ok(database.peakCheckedOutCount() <= database.max);
});

// ---------------------------------------------------------------------------
// Lock released
// ---------------------------------------------------------------------------

test("a timeout releases the advisory lock before the connection returns to the pool", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    timeoutMs: 25,
  });

  await assert.rejects(run.outcome);
  await settleWithin(run);

  assert.equal(
    database.lockHolders(),
    0,
    "the timed-out job must not keep the scheduled lock",
  );
  const unlockIndex = database.events.indexOf(`query:1:${RELEASE_LOCK_SQL}`);
  const releaseIndex = database.events.indexOf("release:1");
  assert.ok(unlockIndex >= 0, "the advisory lock must be explicitly unlocked");
  assert.ok(
    releaseIndex > unlockIndex,
    "the lock must be released before the session returns to the pool",
  );
  assert.ok(database.events.includes(`query:1:${ACQUIRE_LOCK_SQL}`));
});

// ---------------------------------------------------------------------------
// A later run can proceed
// ---------------------------------------------------------------------------

test("a subsequent run of the same job starts and completes after the timed-out run", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const timedOut = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    timeoutMs: 25,
  });

  await assert.rejects(timedOut.outcome);
  await settleWithin(timedOut);

  database.setSourceAvailable(true);
  const rerun = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-2",
  });
  const outcome = await rerun.outcome;
  await settleWithin(rerun);

  assert.equal(outcome.lockAcquired, true, "the rerun must not be locked out");
  assert.equal(outcome.committed, true);
  assert.deepEqual(
    database.committedRows,
    ["run-2"],
    "only the rerun may commit; the timed-out run must leave nothing behind",
  );
  assert.equal(database.checkedOutCount(), 0);
  assert.equal(database.lockHolders(), 0);
  assert.equal(database.openTransactions(), 0);
  assert.ok(
    database.peakCheckedOutCount() <= database.max,
    "the timed-out run must not exhaust the pool for the rerun",
  );
});

// ---------------------------------------------------------------------------
// Cancellation behaves like a timeout
// ---------------------------------------------------------------------------

test("cancellation through an injected abort signal releases the same resources as a timeout", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const controller = new AbortController();
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    signal: controller.signal,
  });

  await database.waitForSourceQuery();
  controller.abort();

  await assert.rejects(run.outcome, (error: unknown) => {
    assert.ok(error instanceof DatabaseDeadlineExceededError);
    assert.equal(error.message, "Database operation aborted by signal");
    return true;
  });
  await settleWithin(run);

  assert.equal(database.cancelledQueries(), 1);
  assert.ok(database.events.includes("query:2:ROLLBACK"));
  assert.deepEqual(database.committedRows, []);
  assert.equal(database.checkedOutCount(), 0);
  assert.equal(countEvents(database.events, "release:"), 2);
  assert.equal(database.lockHolders(), 0);
  assert.equal(database.openTransactions(), 0);
});

// ---------------------------------------------------------------------------
// Handler failure during cancellation
// ---------------------------------------------------------------------------

test("a handler failure raised during cancellation still releases every resource exactly once", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const controller = new AbortController();
  const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
    label: "run-1",
    signal: controller.signal,
    handlerError: new Error("source handler failed"),
  });

  await database.waitForSourceQuery();
  controller.abort();

  await assert.rejects(run.outcome, (error: unknown) => {
    assert.ok(error instanceof DatabaseDeadlineExceededError);
    return true;
  });
  await settleWithin(run);

  assert.ok(
    database.events.includes("query:2:ROLLBACK"),
    "the transaction must be rolled back even when the handler failed",
  );
  assert.deepEqual(database.committedRows, []);
  assert.equal(
    countEvents(database.events, "release:"),
    2,
    "each session must be released exactly once, never twice",
  );
  assert.equal(countEvents(database.events, `query:1:${RELEASE_LOCK_SQL}`), 1);
  assert.equal(database.lockHolders(), 0);
  assert.equal(database.openTransactions(), 0);
});

// ---------------------------------------------------------------------------
// Scheduled cycle and HTTP boundary
// ---------------------------------------------------------------------------

test("a timeout in the rate phase ends the cycle with the partial truth and no success claim", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });

  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: () =>
      runScheduledRefresh({
        snapshotRates: async () => {
          const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
            label: "cycle-1",
            timeoutMs: 25,
          });
          try {
            return await run.outcome.then(() => rateSummary());
          } finally {
            await settleWithin(run);
          }
        },
        evaluateReputation: async () => reputationSummary(),
        suppressions: suppressionRepository(),
        now: () => NOW,
      }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    rates: { failed: number; failures: Array<{ code: string }> };
    reputation: { attempted: number };
  };
  assert.equal(body.ok, false);
  assert.equal(body.rates.failed, 1);
  assert.equal(body.rates.failures[0]?.code, "LIVE_RATE_PREPARATION_FAILURE");
  assert.equal(body.reputation.attempted, 3);

  assert.equal(database.checkedOutCount(), 0);
  assert.equal(database.lockHolders(), 0);
  assert.equal(database.openTransactions(), 0);
  assert.deepEqual(database.committedRows, []);
});

test("a timeout in the reputation phase reaches the HTTP boundary as a safe 500", async () => {
  const database = fakeScheduledDatabase();
  database.setSourceAvailable(false);
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });

  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: () =>
      runScheduledRefresh({
        snapshotRates: async () => rateSummary(),
        evaluateReputation: async () => {
          const run = runScheduledJob(database, REFRESH_LOCK.derivedKey, {
            label: "cycle-2",
            timeoutMs: 25,
          });
          try {
            await run.outcome;
            throw new Error("the reputation phase must not succeed after a timeout");
          } finally {
            await settleWithin(run);
          }
        },
        suppressions: suppressionRepository(),
        now: () => NOW,
      }),
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "internal_error");
  assert.equal(JSON.stringify(body).includes("DATABASE_URL"), false);

  assert.equal(database.checkedOutCount(), 0);
  assert.equal(database.lockHolders(), 0);
  assert.equal(database.openTransactions(), 0);
  assert.deepEqual(database.committedRows, []);
});

// ---------------------------------------------------------------------------
// Bounded evidence transaction
// ---------------------------------------------------------------------------

test("a transaction timeout in the scheduled evidence read fails closed, is not retried, and writes no score", async () => {
  const transactionOptions: Array<{
    isolationLevel: unknown;
    maxWait: number;
    timeout: number;
  }> = [];
  const transactionQueries: string[] = [];
  let rollbacks = 0;

  const db = {
    async $transaction(
      fn: (tx: unknown) => Promise<unknown>,
      options: { isolationLevel: unknown; maxWait: number; timeout: number },
    ) {
      transactionOptions.push(options);
      const tx = {
        async $executeRaw(sql: unknown) {
          transactionQueries.push(String(sql));
          return 0;
        },
        async $executeRawUnsafe(sql: string) {
          transactionQueries.push(sql);
          return 0;
        },
        async $queryRaw() {
          transactionQueries.push("snapshot-identity");
          // The driver aborted the transaction when its bound was exceeded.
          throw Object.assign(
            new Error("Transaction API error: Transaction already closed"),
            { code: "P2028" },
          );
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
  };

  const result = await readInReputationSnapshot(
    db as unknown as Parameters<typeof readInReputationSnapshot>[0],
    async () => "evidence",
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "EVIDENCE_READ_FAILURE");
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.attempts, 1);
  }
  assert.equal(transactionOptions.length, 1, "a timeout must not be retried");
  assert.equal(rollbacks, 1, "the timed-out transaction must be rolled back");
  assert.equal(transactionQueries.length, 2, "the closed transaction must not be used again");

  const options = transactionOptions[0]!;
  assert.ok(
    Number.isFinite(options.timeout) && options.timeout > 0,
    "the evidence read must run in a bounded transaction",
  );
  assert.ok(
    Number.isFinite(options.maxWait) && options.maxWait > 0,
    "the evidence read must bound how long it waits for a connection",
  );

  let upserts = 0;
  const repository: ReputationRepository = {
    readEvidence: async () => (result.ok ? null : result.failure),
    upsertScore: async () => {
      upserts += 1;
      return {
        id: "score-1",
        anchorSlug: "zeam",
        computedAt: NOW,
        writeStatus: "written",
      };
    },
  };

  const summary = await evaluatePersistedAnchorReputations({
    anchorSlugs: ["zeam"],
    evaluatedAt: NOW,
    dependencies: {
      listAnchorSlugs: async () => ["zeam"],
      evaluate: (anchorSlug, options) =>
        evaluateAnchorReputation(anchorSlug, { ...options, repository }),
    },
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0]?.code, "EVIDENCE_READ_FAILURE");
  assert.equal(upserts, 0, "a failed evidence read must not write a score");
});

test("a lock timeout inside the scheduled evidence read is retried a bounded number of times and leaves no transaction open", async () => {
  let attempts = 0;
  let rollbacks = 0;

  const db = {
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      attempts += 1;
      const tx = {
        async $executeRaw() {
          return 0;
        },
        async $executeRawUnsafe() {
          return 0;
        },
        async $queryRaw() {
          throw Object.assign(
            new Error("canceling statement due to lock timeout"),
            { code: "55P03" },
          );
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
  };

  const result = await readInReputationSnapshot(
    db as unknown as Parameters<typeof readInReputationSnapshot>[0],
    async () => "evidence",
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "EVIDENCE_READ_SERIALIZATION_FAILURE");
    assert.equal(result.failure.retryable, true);
    assert.equal(result.failure.attempts, 3);
  }
  assert.equal(attempts, 3, "retries must stay bounded");
  assert.equal(rollbacks, 3, "every attempt must be rolled back");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rateSummary(
  overrides: Partial<SafeLiveRateRunSummary> = {},
): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    suppressed: 0,
    snapshotsPersisted: 1,
    snapshots: [],
    failures: [],
    skippedSources: [],
    ...overrides,
  });
}

function reputationSummary(): ReputationEvaluationRunSummary {
  return Object.freeze({
    attempted: 3,
    succeeded: 3,
    failed: 0,
    failures: [],
  });
}

function suppressionRepository(): SuppressionRepository {
  return Object.freeze({
    listSuppressed: async () => [],
    recordDeterministicFailure: async () => ({} as never),
    reactivate: async () => null,
  });
}
