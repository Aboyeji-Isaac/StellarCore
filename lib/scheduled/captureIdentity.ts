import { createHash, randomUUID } from "node:crypto";

import { RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION } from "@/constants/scheduling";
import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { CaptureRunIdentity, CaptureRunScheduler } from "@/types/scheduling";

export type CaptureRunIdentityInput = Readonly<{
  scheduler: CaptureRunScheduler;
  /** Dispatch time the scheduler asked for, when it is known. */
  scheduledAt?: Date;
  startedAt: Date;
  scheduledIntervalMs: number | null;
  sources?: readonly ReviewedLiveRateSource[];
  runId?: string;
  /** Pre-computed fingerprint, so a run and its result cannot disagree. */
  configurationFingerprint?: string;
}>;

export function createCaptureRunIdentity(
  input: CaptureRunIdentityInput,
): CaptureRunIdentity {
  return Object.freeze({
    runId: input.runId ?? randomUUID(),
    contractVersion: RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
    configurationFingerprint: input.configurationFingerprint
      ?? fingerprintReviewedRateConfiguration(input.sources ?? REVIEWED_LIVE_RATE_SOURCES),
    scheduler: input.scheduler,
    scheduledIntervalMs: input.scheduledIntervalMs,
    scheduledAt: input.scheduledAt ?? input.startedAt,
    startedAt: input.startedAt,
  });
}

/**
 * Stable, non-secret fingerprint of the reviewed rate-source configuration that
 * an observation was captured under. It contains only registry values that are
 * already public in `constants/`, so it is safe to persist, log, and return.
 * Two runs with the same fingerprint observed the same reviewed configuration.
 */
export function fingerprintReviewedRateConfiguration(
  sources: readonly ReviewedLiveRateSource[] = REVIEWED_LIVE_RATE_SOURCES,
): string {
  const canonical = sources
    .map((source) => [
      source.anchorSlug,
      source.corridorSlug,
      source.sellAsset,
      source.buyAsset,
      source.sellAmount,
      source.buyDeliveryMethod ?? "",
      source.countryCode ?? "",
      source.context,
    ].join("\u0000"))
    .sort((left, right) => left.localeCompare(right));

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
