/**
 * Cron request timestamp-window policy (issue #355).
 *
 * Issue #197 adds replay-resistant cron authentication: a request carries a
 * timestamp and the verifier only accepts it inside an allowed clock-skew
 * window. This module is the pure decision logic for that window so boundary
 * behavior is deterministic and fully unit-testable with a fixed clock.
 *
 * Semantics (documented):
 * - Requests whose presented timestamp is inside `[now - allowedSkewMs,
 *   now + allowedSkewMs]` are accepted.
 * - Requests that expired (`timestamp < now - allowedSkewMs`) are rejected.
 * - Future-dated requests (`timestamp > now + allowedSkewMs`) are rejected.
 * - At the exact boundaries, inclusive bounds apply: `now - allowedSkewMs`
 *   and `now + allowedSkewMs` are still within the window.
 *
 * The window applies AFTER bearer verification; a replay-protected request
 * that is authorized but stale must still never invoke the scheduled refresh.
 *
 * This module never sees signing material and never stores nonces; it is a
 * pure function of a presented timestamp and a provided clock.
 */
export const DEFAULT_CRON_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export type CronTimestampDecision =
  | Readonly<{ ok: true; code: "WITHIN_WINDOW" }>
  | Readonly<{
      ok: false;
      code: "TIMESTAMP_EXPIRED" | "TIMESTAMP_FUTURE" | "TIMESTAMP_INVALID";
    }>;

export type EvaluateCronTimestampInput = Readonly<{
  /** ISO-8601 timestamp presented by the cron caller. */
  timestamp: string | undefined;
  now: () => Date;
  allowedSkewMs?: number;
}>;

export function evaluateCronTimestamp(
  input: EvaluateCronTimestampInput,
): CronTimestampDecision {
  const skewMs = input.allowedSkewMs ?? DEFAULT_CRON_TIMESTAMP_SKEW_MS;
  if (!Number.isSafeInteger(skewMs) || skewMs < 0) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_INVALID" });
  }

  const presented = input.timestamp?.trim();
  if (!presented) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_INVALID" });
  }

  const presentedMs = new Date(presented).getTime();
  if (!Number.isFinite(presentedMs)) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_INVALID" });
  }

  const nowMs = input.now().getTime();
  if (!Number.isFinite(nowMs)) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_INVALID" });
  }

  if (presentedMs < nowMs - skewMs) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_EXPIRED" });
  }
  if (presentedMs > nowMs + skewMs) {
    return Object.freeze({ ok: false, code: "TIMESTAMP_FUTURE" });
  }
  return Object.freeze({ ok: true, code: "WITHIN_WINDOW" });
}
