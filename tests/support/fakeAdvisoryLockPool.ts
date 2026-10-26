/**
 * Deterministic test doubles for the scheduled-workflow concurrency controls.
 *
 * Models the two controls the scheduler actually relies on:
 *
 * 1. PostgreSQL session-scoped advisory locks, as issued by
 *    `withAdvisoryLock`: `pg_try_advisory_lock` is non-blocking and a second
 *    session receives `acquired: false`. Acquisition is re-entrant within one
 *    session, and `pg_advisory_unlock` only releases a lock the session holds.
 * 2. A bounded `pg.Pool`: checkouts never exceed the configured maximum, extra
 *    checkouts queue in FIFO order, and a released connection becomes available
 *    to the next waiter.
 *
 * Nothing here touches a database, a network, or production scheduling, and no
 * assertion waits on wall-clock progress: interleavings are driven by explicit
 * promise gates. The only timer is an unreferenced failsafe on
 * `waitForAcquireAttempts`, so a broken control fails the suite instead of
 * hanging it. Any query the scheduled lock boundary does not issue rejects the
 * test instead of silently falling through to a real pool.
 */

import type { PoolClient } from "pg";

export type FakeAdvisoryLockPoolOptions = Readonly<{
  /** Configured pool maximum; the bound the double enforces. */
  maxConnections?: number;
}>;

export type FakeAdvisoryLockPoolStats = Readonly<{
  /** Every lock attempt observed, acquired or rejected. */
  acquireAttempts: number;
  acquired: number;
  rejected: number;
  unlockAttempts: number;
  /** Checkouts fulfilled so far. */
  checkouts: number;
  releases: number;
  activeCheckouts: number;
  /** Highest number of simultaneously checked-out connections observed. */
  peakActiveCheckouts: number;
  /** Checkouts currently waiting for a free connection. */
  queuedCheckouts: number;
}>;

export type FakeAdvisoryLockPool = Readonly<{
  checkoutClient: () => Promise<PoolClient>;
  releaseClient: (client: PoolClient) => void;
  stats: () => FakeAdvisoryLockPoolStats;
  /** Keys currently held by any session, including a session that leaked one. */
  heldKeys: () => readonly bigint[];
  holdsKey: (key: bigint) => boolean;
  /**
   * Resolves once at least `count` lock attempts have been observed. The
   * bounded failsafe turns a broken control into a test failure instead of a
   * hung process; a correct implementation settles it without the timer firing.
   */
  waitForAcquireAttempts: (count: number) => Promise<void>;
}>;

type Session = Readonly<{
  id: number;
  heldKeys: Set<string>;
  client: PoolClient;
}>;

type Waiter = Readonly<{ threshold: number; resolve: () => void }>;

export function createFakeAdvisoryLockPool(
  options: FakeAdvisoryLockPoolOptions = {},
): FakeAdvisoryLockPool {
  const maxConnections = options.maxConnections ?? 4;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error("maxConnections must be a positive integer");
  }

  const counters = {
    acquireAttempts: 0,
    acquired: 0,
    rejected: 0,
    unlockAttempts: 0,
    checkouts: 0,
    releases: 0,
    activeCheckouts: 0,
    peakActiveCheckouts: 0,
  };

  const sessions: Session[] = [];
  const idle: Session[] = [];
  const active = new Set<number>();
  const checkoutQueue: Array<(session: Session) => void> = [];
  const acquireWaiters: Waiter[] = [];

  /** Advisory lock ownership: key -> owning session id (PostgreSQL is session scoped). */
  const holders = new Map<string, number>();

  function settle(waiters: Waiter[], observed: number): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter && observed >= waiter.threshold) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  function freeConnection(session: Session): void {
    const waiter = checkoutQueue.shift();
    if (waiter) {
      waiter(session);
      return;
    }
    idle.unshift(session);
  }

  function activate(session: Session): PoolClient {
    counters.checkouts += 1;
    counters.activeCheckouts += 1;
    counters.peakActiveCheckouts = Math.max(
      counters.peakActiveCheckouts,
      counters.activeCheckouts,
    );
    active.add(session.id);
    return session.client;
  }

  function createSession(id: number): Session {
    const heldKeys = new Set<string>();

    const client = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const key = lockKeyParam(params, sql);
          counters.acquireAttempts += 1;
          const owner = holders.get(key);
          const acquired = owner === undefined || owner === id;
          if (acquired) {
            holders.set(key, id);
            heldKeys.add(key);
            counters.acquired += 1;
          } else {
            counters.rejected += 1;
          }
          settle(acquireWaiters, counters.acquireAttempts);
          return { rows: [{ acquired }] };
        }

        if (/pg_advisory_unlock/.test(sql)) {
          const key = lockKeyParam(params, sql);
          counters.unlockAttempts += 1;
          const released = holders.get(key) === id;
          if (released) {
            holders.delete(key);
            heldKeys.delete(key);
          }
          return { rows: [{ pg_advisory_unlock: released }] };
        }

        // Fail closed: the scheduled lock boundary issues only the two
        // statements above, so anything else would be an unintended dependency.
        throw new Error(
          `fake advisory-lock pool rejected an unexpected query: ${sql.split(/\s+/).slice(0, 4).join(" ")}`,
        );
      },
      release: () => undefined,
    } as unknown as PoolClient;

    return Object.freeze({ id, heldKeys, client });
  }

  function checkoutClient(): Promise<PoolClient> {
    const reusable = idle.shift();
    if (reusable) return Promise.resolve(activate(reusable));

    if (sessions.length < maxConnections) {
      const session = createSession(sessions.length + 1);
      sessions.push(session);
      return Promise.resolve(activate(session));
    }

    // The checkout request is queued synchronously, so a test can observe
    // `queuedCheckouts` immediately after starting an invocation.
    return new Promise<PoolClient>((resolve) => {
      checkoutQueue.push((session) => resolve(activate(session)));
    });
  }

  function releaseClient(client: PoolClient): void {
    const session = sessions.find((candidate) => candidate.client === client);
    if (!session || !active.has(session.id)) {
      throw new Error("fake advisory-lock pool was asked to release a connection it does not own");
    }
    counters.releases += 1;
    counters.activeCheckouts -= 1;
    active.delete(session.id);
    // A session-scoped advisory lock is not released by returning the
    // connection to the pool; only `pg_advisory_unlock` (or session loss) does.
    freeConnection(session);
  }

  return Object.freeze({
    checkoutClient,
    releaseClient,
    stats: (): FakeAdvisoryLockPoolStats => Object.freeze({
      ...counters,
      queuedCheckouts: checkoutQueue.length,
    }),
    heldKeys: (): readonly bigint[] => Object.freeze([...holders.keys()].map((key) => BigInt(key))),
    holdsKey: (key: bigint): boolean => holders.has(key.toString()),
    waitForAcquireAttempts: (count: number): Promise<void> => waitForAttempts(
      acquireWaiters,
      () => counters.acquireAttempts,
      count,
    ),
  });
}

const WAIT_FAILSAFE_MS = 10_000;

function waitForAttempts(
  waiters: Waiter[],
  observed: () => number,
  threshold: number,
): Promise<void> {
  if (observed() >= threshold) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const failsafe = setTimeout(() => {
      reject(new Error(
        `expected ${threshold} advisory-lock attempts, observed ${observed()}`,
      ));
    }, WAIT_FAILSAFE_MS);
    failsafe.unref?.();
    waiters.push({
      threshold,
      resolve: () => {
        clearTimeout(failsafe);
        resolve();
      },
    });
  });
}

function lockKeyParam(params: readonly unknown[] | undefined, sql: string): string {
  const value = params?.[0];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fake advisory-lock pool requires a bigint key parameter for: ${sql}`);
  }
  return value;
}
