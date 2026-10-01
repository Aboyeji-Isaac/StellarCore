import "dotenv/config";

import { runEvidenceIntegrityAudit } from "@/lib/integrity/audit";
import type { EvidenceIntegrityAuditResult } from "@/types/integrity";

/**
 * Read-only operator/CI entry point for the persisted evidence-graph integrity
 * audit. It prints a bounded JSON report that contains stable record keys and
 * remediation guidance only — never row payloads, connection strings, or
 * environment values. It performs no write, update, delete, or transaction.
 *
 * Exit codes:
 *   0  audit completed and found no violations
 *   1  audit found one or more violations, or the snapshot read failed safely
 */
async function main(): Promise<void> {
  const result = await runEvidenceIntegrityAudit();
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok || result.findingCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch(() => {
    const failure: EvidenceIntegrityAuditResult = Object.freeze({
      ok: false,
      code: "SNAPSHOT_READ_FAILURE",
    });
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { db } = await import("@/lib/dbClient");
      await db.$disconnect();
    } catch {
      // The read-only audit may never have opened a connection; nothing to close.
    }
  });
