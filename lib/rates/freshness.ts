import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import { SYSTEM_CLOCK } from "@/lib/clock/clock";
import type { RateFreshness } from "@/types/rates";

/**
 * Freshness is an absolute comparison against the shared server clock. A
 * capturedAt after `now` is always `future` and never `fresh`, so a forward
 * application-clock error cannot make an observation look fresh. A backward
 * error would shrink the reported age, which is exactly why the capture and
 * evaluation boundaries reject materially negative skew before anything is
 * written or scored.
 */
export function getRateFreshness(
  capturedAt: Date | string,
  now: Date = SYSTEM_CLOCK.now(),
): RateFreshness {
  const capturedMs = capturedAt instanceof Date
    ? capturedAt.getTime()
    : Date.parse(capturedAt);
  const nowMs = now.getTime();

  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs)) {
    return Object.freeze({ state: "invalid", ageMs: null });
  }

  const ageMs = nowMs - capturedMs;
  if (ageMs < 0) return Object.freeze({ state: "future", ageMs });
  return Object.freeze({
    state: ageMs <= RATE_FRESHNESS_THRESHOLD_MS ? "fresh" : "stale",
    ageMs,
  });
}
