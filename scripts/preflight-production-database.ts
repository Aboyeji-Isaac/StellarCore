import "dotenv/config";

import { pathToFileURL } from "node:url";

/**
 * Read-only preflight for privileged production workflows.
 *
 * Prints a single line of credential-free JSON describing what the resolved
 * connection claimed, what the server reported, and whether the approved
 * cluster fingerprint and marker both agree. It exits nonzero whenever the
 * answer is "halt", so a workflow that runs it before a migration or a registry
 * bootstrap cannot proceed to the mutation.
 *
 * This script never writes. It issues no statement other than the read-only
 * probe and never prints `DATABASE_URL`, its password, its username, or a raw
 * driver error.
 */
async function main(): Promise<void> {
  const { runPreflight } = await import("@/lib/config/productionDatabasePreflight");
  const result = await runPreflight();

  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    action: result.action,
    targetId: result.targetId,
    configured: result.configured,
    observed: result.observed,
    fingerprint: result.fingerprint,
    fingerprintApproved: result.fingerprintApproved,
    provisioned: result.provisioned,
    issueCount: result.issues.length,
    issues: result.issues,
  })}\n`);

  if (!result.ok) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    // An unexpected failure is reported as a halt with a code only. The thrown
    // value is deliberately discarded because a driver or module error can
    // embed the connection string.
    process.stdout.write(`${JSON.stringify({
      ok: false,
      action: "halt",
      targetId: null,
      issueCount: 1,
      issues: [{ code: "PRODUCTION_DATABASE_PREFLIGHT_FAILURE" }],
    })}\n`);
    process.exitCode = 1;
  });
}
