import "dotenv/config";

import { pathToFileURL } from "node:url";

import { DATABASE_ENVIRONMENT_IDS } from "@/lib/config/environmentGuard";

/**
 * Stamps the target database with its explicit environment identity (#143).
 *
 * Operator-owned tooling: run it once per database right after migrations,
 * from the same protected workflow that runs `prisma migrate deploy`. It is
 * idempotent for the same identity and refuses to rewrite an existing stamp,
 * so a compromised runtime can never re-label a production database.
 *
 * Usage: STELLARCORE_STAMP_ENVIRONMENT=production npm run stamp:environment
 * (DATABASE_URL must point at the database being stamped; the URL is never
 * printed.)
 */
async function main(): Promise<void> {
  const requested = process.env.STELLARCORE_STAMP_ENVIRONMENT?.trim().toLowerCase();
  if (!requested) {
    console.error(JSON.stringify({
      ok: false,
      code: "STAMP_ENVIRONMENT_MISSING",
      allowed: DATABASE_ENVIRONMENT_IDS,
    }));
    process.exitCode = 1;
    return;
  }

  if (!(DATABASE_ENVIRONMENT_IDS as readonly string[]).includes(requested)) {
    console.error(JSON.stringify({
      ok: false,
      code: "STAMP_ENVIRONMENT_INVALID",
      allowed: DATABASE_ENVIRONMENT_IDS,
    }));
    process.exitCode = 1;
    return;
  }

  const { db } = await import("@/lib/dbClient");

  try {
    // Read current stamp without the guard: stamping precedes verification.
    const rows = await db.$queryRaw<{ environment: string }[]>`
      SELECT "environment" FROM "database_environment" WHERE "id" = 1
    `;
    const [existing] = rows;
    if (existing) {
      if (existing.environment === requested) {
        console.log(JSON.stringify({
          ok: true,
          code: "ALREADY_STAMPED",
          environment: requested,
        }));
        return;
      }
      console.error(JSON.stringify({
        ok: false,
        code: "STAMP_CONFLICT",
        stamped: existing.environment,
        requested,
      }));
      process.exitCode = 1;
      return;
    }

    await db.$executeRaw`
      INSERT INTO "database_environment" ("id", "environment")
      VALUES (1, ${requested}::text)
    `;
    console.log(JSON.stringify({ ok: true, code: "STAMPED", environment: requested }));
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main()
    .catch(() => {
      console.error(JSON.stringify({ ok: false, code: "STAMP_FAILURE" }));
      process.exitCode = 1;
    });
}
