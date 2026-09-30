/**
 * Bounded structured logging for the scheduled refresh.
 *
 * Every event carries the durable run id and, where relevant, the phase and
 * truthful terminal state so an operator can correlate the internal cron
 * response with persisted rows. Only whitelisted scalar fields are emitted:
 * this helper never serializes an error message, stack trace, authorization
 * header, or raw remote response body. See docs/runbook-scheduled-refresh.md.
 *
 * Coordinate changes here with the structured-logging work tracked in #58 so
 * the field names stay stable for whatever sink consumes them.
 */

export type RefreshRunLogEventName =
  | "refresh_run_started"
  | "refresh_run_phase"
  | "refresh_run_completed"
  | "refresh_run_already_running"
  | "refresh_run_interrupted";

export type RefreshRunLogEvent = Readonly<{
  event: RefreshRunLogEventName;
  runId: string;
  state?: string | undefined;
  phase?: string | undefined;
  phaseState?: string | undefined;
  attempt?: number | undefined;
  resumedFromId?: string | null | undefined;
  activeRunId?: string | null | undefined;
  code?: string | undefined;
  durationMs?: number | undefined;
}>;

export type RefreshRunLogger = (event: RefreshRunLogEvent) => void;

export function emitRefreshRunLog(event: RefreshRunLogEvent): void {
  process.stdout.write(`${JSON.stringify({
    level: "info",
    component: "scheduled-refresh",
    ...sanitizeEvent(event),
  })}\n`);
}

const MAX_LOG_FIELD_LENGTH = 80;
const SAFE_LOG_FIELD_PATTERN = /^[A-Za-z0-9_.:-]*$/;

function sanitizeEvent(event: RefreshRunLogEvent): RefreshRunLogEvent {
  const sanitized: Record<string, unknown> = { event: event.event };
  for (const [key, value] of Object.entries(event)) {
    if (key === "event") continue;
    if (value === undefined) continue;
    if (typeof value === "string") {
      sanitized[key] = SAFE_LOG_FIELD_PATTERN.test(value)
        ? value.slice(0, MAX_LOG_FIELD_LENGTH)
        : "[redacted]";
      continue;
    }
    if (typeof value === "number" || value === null) {
      sanitized[key] = value;
    }
  }
  return Object.freeze(sanitized as RefreshRunLogEvent);
}
