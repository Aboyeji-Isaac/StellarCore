import { createHash } from "node:crypto";

import type {
  CaptureLockAcquisition,
  CaptureLockPort,
  CaptureLockUnavailableReason,
} from "@/types/scheduling";

/**
 * Stable, StellarCore-owned advisory-lock namespace. The key is derived rather
 * than hand-written so it cannot drift between callers, and it is never reused
 * for a different lifecycle.
 */
const RATE_CAPTURE_LOCK_NAMESPACE = "stellarcore:rate-capture:v1";

/** Fits in a signed 64-bit integer, which is what PostgreSQL requires. */
export const RATE_CAPTURE_ADVISORY_LOCK_KEY = BigInt(
  `0x${createHash("sha256")
    .update(RATE_CAPTURE_LOCK_NAMESPACE)
    .digest("hex")
    .slice(0, 15)}`,
);

/**
 * Session advisory lock held on one dedicated connection for the whole capture
 * run.
 *
 * The connection is deliberately not taken from the shared Prisma pool: a
 * session lock is owned by the connection that took it, so a pooled connection
 * could release it or return it to the pool while the run is still working.
 * `finally`-style release, plus automatic release when the connection closes,
 * is what makes an invocation that dies mid-run safe to retry on the next tick.
 *
 * The acquisition result is a plain value rather than a thrown error: overlap
 * is expected under a bounded cadence and must be reported as a truthful
 * `already_running` outcome, not as a failure.
 */
export const POSTGRES_ADVISORY_CAPTURE_LOCK: CaptureLockPort = Object.freeze({
  async acquire(): Promise<CaptureLockAcquisition> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return unavailable("LOCK_UNAVAILABLE");

    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString });
      await client.connect();

      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [RATE_CAPTURE_ADVISORY_LOCK_KEY.toString()],
      );
      if (result.rows[0]?.locked !== true) {
        await close(client);
        return unavailable("ALREADY_RUNNING");
      }

      let released = false;
      return Object.freeze({
        acquired: true as const,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await client.query(
              "SELECT pg_advisory_unlock($1::bigint)",
              [RATE_CAPTURE_ADVISORY_LOCK_KEY.toString()],
            );
          } catch {
            // The server releases the session lock when the connection closes.
          } finally {
            await close(client);
          }
        },
      });
    } catch {
      return unavailable("LOCK_UNAVAILABLE");
    }
  },
});

/**
 * Single-process exclusion for local development and tests. It proves the same
 * contract as the advisory lock without requiring a database, and it is
 * documented as unsuitable for production.
 */
export function createProcessCaptureLock(): CaptureLockPort {
  let held = false;
  return Object.freeze({
    async acquire(): Promise<CaptureLockAcquisition> {
      if (held) return unavailable("ALREADY_RUNNING");
      held = true;
      return Object.freeze({
        acquired: true as const,
        release: async (): Promise<void> => {
          held = false;
        },
      });
    },
  });
}

function unavailable(reason: CaptureLockUnavailableReason): CaptureLockAcquisition {
  return Object.freeze({ acquired: false, reason });
}

async function close(client: { end: () => Promise<void> }): Promise<void> {
  try {
    await client.end();
  } catch {
    // Closing a connection that never opened, or already closed, is not an error.
  }
}
