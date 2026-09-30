import "dotenv/config";

import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  RUNTIME_ENVIRONMENTS,
  isRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/lib/config/environment";

/**
 * Issue #143: write the durable database-environment identity row (exactly
 * one). Run once per database during environment provisioning:
 *
 *   STELLARCORE_ENVIRONMENT=preview npx tsx scripts/mark-database-environment.ts
 *   # or non-interactive:
 *   STELLARCORE_ENVIRONMENT=preview MARK_DATABASE_ENVIRONMENT=preview \
 *     npx tsx scripts/mark-database-environment.ts
 *
 * Production marking is intentionally interactive-only (no env override) so a
 * stray CI variable can never mark a database as production.
 */
async function main(): Promise<void> {
  const runtimeRaw = process.env.STELLARCORE_ENVIRONMENT;
  if (!isRuntimeEnvironment(runtimeRaw)) {
    console.error(JSON.stringify({
      ok: false,
      code: "RUNTIME_ENVIRONMENT_UNDECLARED",
      allowed: RUNTIME_ENVIRONMENTS,
    }));
    process.exitCode = 1;
    return;
  }
  const runtime: RuntimeEnvironment = runtimeRaw;

  const override = process.env.MARK_DATABASE_ENVIRONMENT;
  let target: RuntimeEnvironment | undefined = isRuntimeEnvironment(override)
    ? override
    : undefined;

  if (!target) {
    if (runtime === "production") {
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = (await rl.question(
        `Mark THIS database as "production"? Type "production" to confirm: `,
      )).trim();
      rl.close();
      if (answer !== "production") {
        console.error(JSON.stringify({ ok: false, code: "MARK_CONFIRMATION_REQUIRED" }));
        process.exitCode = 1;
        return;
      }
      target = "production";
    } else {
      target = runtime;
    }
  } else if (runtime === "production") {
    console.error(JSON.stringify({ ok: false, code: "PRODUCTION_MARK_INTERACTIVE_ONLY" }));
    process.exitCode = 1;
    return;
  }

  const { db } = await import("@/lib/dbClient");
  try {
    await db.$executeRaw`
      INSERT INTO environment_identity (id, environment, marked_at, note)
      VALUES (1, ${target}, now(), ${`marked by mark-database-environment.ts as ${target}`})
      ON CONFLICT (id) DO UPDATE
      SET environment = EXCLUDED.environment, marked_at = now(), note = EXCLUDED.note`;
    console.log(JSON.stringify({ ok: true, marked: target }));
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "MARK_DATABASE_ENVIRONMENT_FAILURE" }));
    process.exitCode = 1;
  });
}
