import type { PoolClient } from "pg";

import { resolveKey } from "@/lib/scheduled/advisoryLockKey";
import { createStructuredLogger } from "@/lib/scheduled/structuredLog";

export type AdvisoryLockResult =
  | Readonly<{ acquired: true; key: bigint }>
  | Readonly<{ acquired: false; key: bigint; reason: "already_held" }>;

export type AdvisoryLockCleanupStep = "UNLOCK" | "RELEASE";

/**
 * Sanitized description of one failed cleanup step. It carries a bounded step
 * name and code only: never the underlying exception, connection details,
 * credential-bearing URLs, or query text.
 */
export type AdvisoryLockCleanupFailure = Readonly<{
  step: AdvisoryLockCleanupStep;
  code: "UNLOCK_FAILURE" | "RELEASE_FAILURE";
}>;

/**
 * Raised when the lock boundary cannot finish cleanup after an otherwise
 * successful body. The message is bounded on purpose so a public error
 * boundary can surface it without leaking exception content.
 */
export class AdvisoryLockCleanupError extends Error {
  readonly code = "CLEANUP_FAILURE";
  readonly step: AdvisoryLockCleanupStep;
  readonly failures: readonly AdvisoryLockCleanupFailure[];

  constructor(failures: readonly AdvisoryLockCleanupFailure[]) {
    super("Advisory lock cleanup failed");
    this.name = "AdvisoryLockCleanupError";
    this.failures = Object.freeze([...failures]);
    this.step = this.failures[0]?.step ?? "RELEASE";
  }
}

export type AdvisoryLockClientDependencies = Readonly<{
  /** Returns a checked-out pool client; caller must not release it. */
  checkoutClient: () => Promise<PoolClient>;
  /** Releases the checked-out client back to the pool. */
  releaseClient: (client: PoolClient) => void;
  /**
   * Records one sanitized cleanup failure. A throwing reporter is ignored so
   * recording can never replace the workflow outcome or stop later cleanup.
   */
  reportCleanupFailure?: (failure: AdvisoryLockCleanupFailure) => void;
}>;

/**
 * Attempts a non-blocking session-scoped PostgreSQL advisory lock.
 * The checked-out connection is held for the duration of `body`; the lock
 * is released (and the connection returned) in `finally`, even on throw.
 * A lost connection releases the session lock automatically.
 *
 * Cleanup failures never replace the operation outcome:
 * - a body or acquire failure is rethrown unchanged, so the primary failure
 *   stays identifiable even when unlock and/or release also throw;
 * - every cleanup step is still attempted after an earlier cleanup step fails;
 * - each failure is recorded as a sanitized `AdvisoryLockCleanupFailure`;
 * - if the body succeeded but returning the connection failed, the boundary
 *   rejects with a bounded `AdvisoryLockCleanupError` instead of reporting a
 *   success it cannot guarantee. An unlock failure alone is recorded but not
 *   fatal, because losing the session releases its advisory lock automatically.
 *
 * @param key     — signed int8 key derived by `deriveLockKey`
 * @param body    — work to execute while the lock is held
 * @param deps    — injectable connection factory (default: DATABASE_URL pool)
 */
export async function withAdvisoryLock<T>(
  key: bigint,
  body: () => Promise<T>,
  deps: AdvisoryLockClientDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ result: T; lock: AdvisoryLockResult } | { lock: AdvisoryLockResult }> {
  const client = await deps.checkoutClient();
  const cleanupFailures: AdvisoryLockCleanupFailure[] = [];
  const recordCleanupFailure = (failure: AdvisoryLockCleanupFailure): void => {
    const frozen = Object.freeze({ ...failure });
    cleanupFailures.push(frozen);
    try {
      deps.reportCleanupFailure?.(frozen);
    } catch {
      // Recording must never break the workflow outcome or later cleanup.
    }
  };

  let acquired = false;
  let lock: AdvisoryLockResult | undefined;
  let completed: { result: T } | undefined;
  let operationFailure: { error: unknown } | undefined;

  try {
    acquired = await tryAcquire(client, key);
    lock = acquired
      ? Object.freeze({ acquired: true as const, key })
      : Object.freeze({ acquired: false as const, key, reason: "already_held" as const });

    if (acquired) {
      try {
        completed = { result: await body() };
      } catch (error) {
        operationFailure = { error };
      }
    }
  } catch (error) {
    // The acquire step itself failed; cleanup below must not replace it.
    operationFailure = { error };
  } finally {
    if (acquired) {
      await unlockQuietly(client, key, recordCleanupFailure);
    }
    returnConnection(client, deps, recordCleanupFailure);
  }

  if (operationFailure) throw operationFailure.error;
  // An unlock failure on a lost session is expected to have released the lock
  // already, so it is recorded without failing work that completed. A failure
  // to return the connection leaves the pool holding it: the boundary must not
  // report success it cannot account for.
  if (cleanupFailures.some((failure) => failure.step === "RELEASE")) {
    throw new AdvisoryLockCleanupError(cleanupFailures);
  }
  if (lock === undefined) throw new Error("advisory lock outcome was not recorded");
  return completed ? Object.freeze({ result: completed.result, lock }) : Object.freeze({ lock });
}

/**
 * Sanitized diagnostic string for a raw int8 advisory lock key.
 * Never includes payload data; safe for logs and metrics.
 */
export function describeLockKey(key: bigint): string {
  const descriptor = resolveKey(key);
  if (descriptor) {
    return `advisory_lock(key=${key}, name="${descriptor.logicalName}", domain=${descriptor.domainId})`;
  }
  return `advisory_lock(key=${key}, name=<unknown>)`;
}

async function tryAcquire(client: PoolClient, key: bigint): Promise<boolean> {
  const { rows } = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [key.toString()],
  );
  return rows[0]?.acquired === true;
}

async function unlockQuietly(
  client: PoolClient,
  key: bigint,
  recordCleanupFailure: (failure: AdvisoryLockCleanupFailure) => void,
): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
  } catch {
    // A lost connection releases the session lock automatically, so an unlock
    // failure is recorded rather than treated as fatal. The connection is still
    // returned so later cleanup steps continue.
    recordCleanupFailure({ step: "UNLOCK", code: "UNLOCK_FAILURE" });
  }
}

function returnConnection(
  client: PoolClient,
  deps: AdvisoryLockClientDependencies,
  recordCleanupFailure: (failure: AdvisoryLockCleanupFailure) => void,
): void {
  try {
    deps.releaseClient(client);
  } catch {
    // The connection was not returned: never let this replace the operation
    // outcome, but record it so the failure is not silently swallowed.
    recordCleanupFailure({ step: "RELEASE", code: "RELEASE_FAILURE" });
  }
}

const cleanupLogger = createStructuredLogger("scheduled-advisory-lock");

function logCleanupFailure(failure: AdvisoryLockCleanupFailure): void {
  cleanupLogger.error("Scheduled advisory-lock cleanup failed", {
    step: failure.step,
    code: failure.code,
  });
}

// The default pool must allow more than one checked-out connection. A one-client
// pool would serialize overlapping callers at checkout, causing the second call
// to wait and run later instead of observing the held advisory lock and returning
// the intended "already_held" result.
function buildDefaultDependencies(): AdvisoryLockClientDependencies {
  let pool: import("pg").Pool | undefined;

  function getPool(): import("pg").Pool {
    if (!pool) {
      // Dynamic require keeps test boundaries that inject dependencies isolated.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg") as typeof import("pg");
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL is not defined");
      pool = new Pool({ connectionString });
    }
    return pool;
  }

  return Object.freeze({
    checkoutClient: () => getPool().connect(),
    releaseClient: (client: PoolClient) => client.release(),
    reportCleanupFailure: logCleanupFailure,
  });
}

const DEFAULT_DEPENDENCIES = buildDefaultDependencies();
