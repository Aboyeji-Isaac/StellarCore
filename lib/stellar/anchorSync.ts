import { AnchorStatus } from "@/app/generated/prisma/enums";
import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  discoverAnchor as discoverRegistryAnchor,
  Sep1DiscoveryError,
  type Sep1ErrorCode,
} from "@/lib/stellar/sep1";
import { recordSep1Observation } from "@/lib/stellar/sep1HistoryRepository";
import type { Sep1Assessment, Sep1FieldDiff } from "@/lib/stellar/sep1History";
import type {
  AnchorRegistryEntry,
  DiscoveredAnchor,
} from "@/types/anchor";

export type PersistedAnchor = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  tomlUrl: string;
  seps: readonly number[];
  isTransferCapable: boolean;
  status: AnchorStatus;
  /**
   * Result of the SEP-1 review gate for this discovery. Absent when the
   * persister did not record history. CHANGED_UNREVIEWED means the observation
   * was retained but the public projection was NOT updated.
   */
  discovery?: Readonly<{
    digest: string;
    assessment: Sep1Assessment;
    diff: readonly Sep1FieldDiff[];
  }>;
}>;

export type AnchorSyncFailureCode =
  | Sep1ErrorCode
  | "PERSISTENCE_FAILURE"
  | "UNEXPECTED_ERROR";

export type AnchorSyncFailure = Readonly<{
  slug: string;
  phase: "DISCOVERY" | "PERSISTENCE";
  code: AnchorSyncFailureCode;
  statusUpdate: "MARKED_DOWN" | "NOT_FOUND" | "FAILED" | "NOT_ATTEMPTED";
}>;

export type AnchorSyncResult = Readonly<{
  totalAttempted: number;
  succeeded: number;
  failed: number;
  successfulSlugs: readonly string[];
  failures: readonly AnchorSyncFailure[];
  /**
   * Anchors whose fresh SEP-1 metadata changed a sensitive field without
   * review. Distinct from failures: discovery succeeded, the observation is
   * retained, and the last approved projection is kept.
   */
  quarantinedSlugs: readonly string[];
}>;

export type AnchorSyncDependencies = Readonly<{
  discover: (entry: AnchorRegistryEntry) => Promise<DiscoveredAnchor>;
  persist: (anchor: DiscoveredAnchor) => Promise<PersistedAnchor>;
  markDown: (slug: string) => Promise<boolean>;
}>;

const ANCHOR_SELECT = {
  slug: true,
  name: true,
  homeDomain: true,
  tomlUrl: true,
  seps: true,
  isTransferCapable: true,
  status: true,
} as const;

export async function persistDiscoveredAnchor(
  anchor: DiscoveredAnchor,
): Promise<PersistedAnchor> {
  const { db } = await import("@/lib/dbClient");
  const data = {
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    tomlUrl: anchor.tomlUrl,
    seps: [...anchor.seps],
    isTransferCapable: anchor.isTransferCapable,
    status: AnchorStatus.LIVE,
  };

  return db.$transaction(async (tx) => {
    const existing = await tx.anchor.findUnique({
      where: { slug: anchor.slug },
      select: { id: true },
    });
    // The anchor row must exist to own history; a brand-new anchor has no
    // approved baseline, so its first projection is created as before.
    const row = existing ?? await tx.anchor.create({
      data: { slug: anchor.slug, ...data },
      select: { id: true },
    });
    const recorded = await recordSep1Observation(tx, row.id, anchor);
    const discovery = Object.freeze({
      digest: recorded.digest,
      assessment: recorded.assessment,
      diff: recorded.diff,
    });

    // Quarantine: keep the last approved public projection untouched (and do
    // not change status; a metadata change is not an availability signal).
    const persisted = recorded.assessment === "CHANGED_UNREVIEWED"
      ? await tx.anchor.findUniqueOrThrow({
          where: { slug: anchor.slug },
          select: ANCHOR_SELECT,
        })
      : await tx.anchor.update({
          where: { slug: anchor.slug },
          data,
          select: ANCHOR_SELECT,
        });

    return freezePersistedAnchor(persisted, discovery);
  });
}

export async function markAnchorDownIfExists(slug: string): Promise<boolean> {
  const { db } = await import("@/lib/dbClient");
  const result = await db.anchor.updateMany({
    where: { slug },
    data: { status: AnchorStatus.DOWN },
  });

  return result.count > 0;
}

export async function syncAnchorRegistry(
  entries: readonly AnchorRegistryEntry[] = ANCHOR_REGISTRY,
  dependencies: AnchorSyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
): Promise<AnchorSyncResult> {
  const successfulSlugs: string[] = [];
  const failures: AnchorSyncFailure[] = [];
  const quarantinedSlugs: string[] = [];

  for (const entry of entries) {
    let discovered: DiscoveredAnchor;

    try {
      discovered = await dependencies.discover(entry);
    } catch (error) {
      failures.push(
        Object.freeze({
          slug: entry.slug,
          phase: "DISCOVERY",
          code: classifyDiscoveryFailure(error),
          statusUpdate: await safelyMarkDown(entry.slug, dependencies.markDown),
        }),
      );
      continue;
    }

    try {
      const persisted = await dependencies.persist(discovered);
      successfulSlugs.push(entry.slug);
      if (persisted?.discovery?.assessment === "CHANGED_UNREVIEWED") {
        quarantinedSlugs.push(entry.slug);
      }
    } catch {
      failures.push(
        Object.freeze({
          slug: entry.slug,
          phase: "PERSISTENCE",
          code: "PERSISTENCE_FAILURE",
          statusUpdate: "NOT_ATTEMPTED",
        }),
      );
    }
  }

  return Object.freeze({
    totalAttempted: entries.length,
    succeeded: successfulSlugs.length,
    failed: failures.length,
    successfulSlugs: Object.freeze(successfulSlugs),
    failures: Object.freeze(failures),
    quarantinedSlugs: Object.freeze(quarantinedSlugs),
  });
}

const DEFAULT_SYNC_DEPENDENCIES = Object.freeze({
  discover: discoverRegistryAnchor,
  persist: persistDiscoveredAnchor,
  markDown: markAnchorDownIfExists,
}) satisfies AnchorSyncDependencies;

function classifyDiscoveryFailure(error: unknown): AnchorSyncFailureCode {
  return error instanceof Sep1DiscoveryError ? error.code : "UNEXPECTED_ERROR";
}

async function safelyMarkDown(
  slug: string,
  markDown: AnchorSyncDependencies["markDown"],
): Promise<AnchorSyncFailure["statusUpdate"]> {
  try {
    return (await markDown(slug)) ? "MARKED_DOWN" : "NOT_FOUND";
  } catch {
    return "FAILED";
  }
}

function freezePersistedAnchor(
  anchor: {
    slug: string;
    name: string;
    homeDomain: string;
    tomlUrl: string;
    seps: number[];
    isTransferCapable: boolean;
    status: AnchorStatus;
  },
  discovery?: PersistedAnchor["discovery"],
): PersistedAnchor {
  return Object.freeze({
    ...anchor,
    seps: Object.freeze([...anchor.seps]),
    ...(discovery ? { discovery } : {}),
  });
}
