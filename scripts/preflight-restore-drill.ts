import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  assertRestoreDrillTargetAllowed,
  resolveRestoreDrillTargetFromEnv,
  RestoreDrillTargetError,
} from "@/lib/db/restoreDrillGuard";

/**
 * Preflight CLI script for restore drill target identity verification.
 * Runs in CI workflows and operator commands before any restore action.
 *
 * Exits with code 0 if target identity is approved.
 * Exits with code 1 and a secret-free error JSON if target identity is production,
 * missing, or unapproved.
 */
export async function main(): Promise<void> {
  const target = resolveRestoreDrillTargetFromEnv();

  try {
    const approved = assertRestoreDrillTargetAllowed(target);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        code: "TARGET_IDENTITY_APPROVED",
        targetEnvironment: approved.targetEnvironment,
        targetHost: approved.targetHost,
        targetDatabase: approved.targetDatabase,
      })}\n`,
    );
  } catch (error) {
    if (error instanceof RestoreDrillTargetError) {
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          code: error.code,
          reason: error.reason,
          targetEnvironment: error.targetEnvironment,
          targetHost: error.targetHost,
          targetDatabase: error.targetDatabase,
        })}\n`,
      );
    } else {
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          code: "TARGET_PREFLIGHT_ERROR",
          reason: "An unexpected error occurred during target preflight validation.",
        })}\n`,
      );
    }
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
