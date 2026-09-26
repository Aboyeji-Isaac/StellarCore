import type { BadgeTone } from "@/components/ui/EvidenceBadge";
import type { PublicAnchorStatus } from "@/types/api/anchors";

export type SyncStatusPresentation = Readonly<{
  tone: BadgeTone;
  label: string;
}>;

/**
 * Persisted synchronization state, using the same "Synced" wording the
 * dashboard already uses so status is never presented as live availability.
 */
export function syncStatusPresentation(
  status: PublicAnchorStatus,
): SyncStatusPresentation {
  switch (status) {
    case "LIVE":
      return Object.freeze({ tone: "positive" as const, label: "Synced" });
    case "DEGRADED":
      return Object.freeze({ tone: "warning" as const, label: "Sync degraded" });
    case "DOWN":
      return Object.freeze({ tone: "negative" as const, label: "Sync failed" });
    case "UNKNOWN":
      return Object.freeze({ tone: "neutral" as const, label: "Sync unknown" });
  }
}
