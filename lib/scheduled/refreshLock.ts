import { Client } from "pg";

/**
 * Session-level PostgreSQL advisory lock guarding the scheduled refresh,
 * as selected by docs/rfc-cron-locking.md.
 *
 * The lock is held on one dedicated connection for the whole orchestration
 * and released in `finally`. A transaction-scoped lock is deliberately NOT
 * used: the refresh performs external SEP requests and must not hold a
 * long-running database transaction around them. If the process dies, the
 * session ends and PostgreSQL releases the lock automatically; the orphaned
 * RUNNING run row is then reclaimed as interrupted by the next run (see
 * lib/scheduled/refresh.ts).
 *
 * Key derivation: first 16 hex digits of
 * sha256("stellarcore:scheduled-refresh"), split into two signed int32
 * halves for pg_try_advisory_lock(int, int).
 */
export const REFRESH_ADVISORY_LOCK_KEY = Object.freeze({
  namespace: 514905693,
  key: 921399859,
}) as Readonly<{ namespace: number; key: number }>;

export type RefreshLockLease = Readonly<{
  release: () => Promise<void>;
}>;

export type RefreshLockOutcome =
  | Readonly<{ acquired: true; lease: RefreshLockLease }>
  | Readonly<{ acquired: false }>;

export type RefreshLockProvider = Readonly<{
  acquire: () => Promise<RefreshLockOutcome>;
}>;

export type PostgresRefreshLockProviderOptions = Readonly<{
  connectionString?: string | undefined;
  namespace?: number | undefined;
  key?: number | undefined;
}>;

export function createPostgresRefreshLockProvider(
  options: PostgresRefreshLockProviderOptions = {},
): RefreshLockProvider {
  const namespace = options.namespace ?? REFRESH_ADVISORY_LOCK_KEY.namespace;
  const key = options.key ?? REFRESH_ADVISORY_LOCK_KEY.key;
  return Object.freeze({
    acquire: () => acquireSessionAdvisoryLock(options.connectionString, namespace, key),
  });
}

async function acquireSessionAdvisoryLock(
  connectionString: string | undefined,
  namespace: number,
  key: number,
): Promise<RefreshLockOutcome> {
  const resolved = connectionString ?? process.env.DATABASE_URL;
  if (!resolved) {
    throw new Error("DATABASE_URL is not defined");
  }
  const client = new Client({ connectionString: resolved });
  await client.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS "acquired"',
      [namespace, key],
    );
    if (result.rows[0]?.acquired !== true) {
      await client.end();
      return Object.freeze({ acquired: false as const });
    }
    let released = false;
    return Object.freeze({
      acquired: true as const,
      lease: Object.freeze({
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query("SELECT pg_advisory_unlock($1, $2)", [namespace, key]);
          } finally {
            // Ending the session releases any session-level advisory lock
            // even when the explicit unlock fails, so the lock scope stays
            // bounded on success, failure, timeout, and thrown exceptions.
            await client.end();
          }
        },
      }),
    });
  } catch (error) {
    await client.end();
    throw error;
  }
}
