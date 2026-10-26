import type { ScheduledSuppressionReason } from "@/lib/scheduled/suppression";

export type ScheduledSourceSuppression = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  state: "ACTIVE" | "SUPPRESSED";
  reason: ScheduledSuppressionReason;
  failureCode: string;
  failurePhase: string;
  consecutiveFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
  suppressedAt: string | null;
  reactivatedAt: string | null;
  reactivationReason: string | null;
}>;

export type ScheduledSourceIdentity = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
}>;

export type ScheduledSuppressionFailureInput = ScheduledSourceIdentity & Readonly<{
  reason: ScheduledSuppressionReason;
  failureCode: string;
  failurePhase: string;
  observedAt: Date;
}>;

export type ScheduledSuppressionReactivationInput = ScheduledSourceIdentity & Readonly<{
  reason: string;
  reactivatedAt: Date;
}>;
