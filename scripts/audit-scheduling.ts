/**
 * Offline, deterministic audit of the checked-in capture schedule.
 *
 * It proves that the capture cadence this repository would deploy fits inside
 * the shared freshness threshold plus the documented execution safety margin,
 * and fails the process otherwise. It reads repository files and the
 * server-only `RATE_CAPTURE_SCHEDULER` selection only: no database, no network,
 * no anchor access. Passing means the schedule is internally coherent, not that
 * any anchor is reachable, quoting, or that a rate was observed.
 */
async function main(): Promise<void> {
  try {
    const { auditDeployedCaptureSchedule } = await import(
      "@/lib/scheduling/deploymentSchedule"
    );
    const audit = auditDeployedCaptureSchedule();

    process.stdout.write(`${JSON.stringify({
      ok: audit.ok,
      contract: audit.contract,
      selectedScheduler: audit.selectedScheduler,
      intervalMs: audit.intervalMs,
      issues: audit.issues,
    })}\n`);

    if (!audit.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      contract: null,
      selectedScheduler: null,
      intervalMs: null,
      issues: [{
        code: "SCHEDULING_AUDIT_LOAD_FAILURE",
        severity: "error",
        detail: "The checked-in capture schedule could not be evaluated.",
      }],
    })}\n`);
    process.exitCode = 1;
  }
}

void main();

export {};
