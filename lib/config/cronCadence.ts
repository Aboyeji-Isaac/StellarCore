/** Deterministic verification of the one reviewed Vercel cron cadence. */
export const EXPECTED_CRON_PATH = "/api/internal/cron/refresh";
export const EXPECTED_CRON_SCHEDULE = "0 0 * * *";
export const EXPECTED_CRON_TIMEZONE = "UTC";

export type CronCadenceIssueCode =
  | "CRON_CONFIGURATION_MISSING"
  | "CRON_CONFIGURATION_MALFORMED"
  | "CRON_JOB_COUNT_DRIFT"
  | "CRON_PATH_DRIFT"
  | "CRON_CADENCE_DRIFT"
  | "CRON_TIMEZONE_DRIFT";

export type CronCadenceIssue = Readonly<{
  code: CronCadenceIssueCode;
  field?: "crons" | "path" | "schedule" | "timezone";
}>;

export type CronCadenceAuditResult = Readonly<{
  ok: boolean;
  issues: readonly CronCadenceIssue[];
}>;

/**
 * Vercel cron schedules are interpreted in UTC. The verifier intentionally
 * accepts only the one production refresh path and its documented daily
 * midnight schedule; a timezone override or a different valid schedule is
 * reported as drift, while invalid shapes and expressions are malformed.
 */
export function auditCronCadenceConfiguration(value: unknown): CronCadenceAuditResult {
  if (!isRecord(value) || !Object.hasOwn(value, "crons")) {
    return result([issue("CRON_CONFIGURATION_MISSING", "crons")]);
  }
  if (!Array.isArray(value.crons)) {
    return result([issue("CRON_CONFIGURATION_MALFORMED", "crons")]);
  }
  if (value.crons.length === 0) {
    return result([issue("CRON_CONFIGURATION_MISSING", "crons")]);
  }
  if (value.crons.length !== 1) {
    return result([issue("CRON_JOB_COUNT_DRIFT", "crons")]);
  }

  const job = value.crons[0];
  if (!isRecord(job)) return result([issue("CRON_CONFIGURATION_MALFORMED", "crons")]);

  const issues: CronCadenceIssue[] = [];
  if (typeof job.path !== "string" || typeof job.schedule !== "string") {
    return result([issue("CRON_CONFIGURATION_MALFORMED", typeof job.path === "string" ? "schedule" : "path")]);
  }
  if (job.path !== EXPECTED_CRON_PATH) issues.push(issue("CRON_PATH_DRIFT", "path"));

  const timezone = job.timezone ?? value.timezone;
  if (timezone !== undefined && timezone !== EXPECTED_CRON_TIMEZONE) {
    issues.push(issue("CRON_TIMEZONE_DRIFT", "timezone"));
  }
  if (hasTimezonePrefix(job.schedule)) {
    issues.push(issue("CRON_TIMEZONE_DRIFT", "schedule"));
  } else if (!isValidCronExpression(job.schedule)) {
    issues.push(issue("CRON_CONFIGURATION_MALFORMED", "schedule"));
  } else if (job.schedule !== EXPECTED_CRON_SCHEDULE) {
    issues.push(issue("CRON_CADENCE_DRIFT", "schedule"));
  }

  return result(issues);
}

function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  return fields.length === ranges.length
    && fields.every((field, index) => isValidCronField(field, ranges[index][0], ranges[index][1]));
}

function isValidCronField(field: string, minimum: number, maximum: number): boolean {
  if (!field) return false;
  return field.split(",").every((part) => {
    if (!part) return false;
    const segments = part.split("/");
    if (segments.length > 2) return false;
    const [range, stepText] = segments;
    if (stepText !== undefined) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) return false;
    }
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2 || bounds.some((bound) => !/^\d+$/.test(bound))) return false;
    const start = Number(bounds[0]);
    const end = Number(bounds[1] ?? bounds[0]);
    return start >= minimum && end <= maximum && start <= end;
  });
}

function hasTimezonePrefix(expression: string): boolean {
  return /^(?:TZ|CRON_TZ)=\S+\s+/i.test(expression.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: CronCadenceIssueCode, field?: CronCadenceIssue["field"]): CronCadenceIssue {
  return Object.freeze({ code, ...(field ? { field } : {}) });
}

function result(issues: CronCadenceIssue[]): CronCadenceAuditResult {
  const frozenIssues = Object.freeze([...issues]);
  return Object.freeze({ ok: frozenIssues.length === 0, issues: frozenIssues });
}
