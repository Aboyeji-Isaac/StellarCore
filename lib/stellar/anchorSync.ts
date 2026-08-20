import { AnchorStatus } from "@/app/generated/prisma/enums";
import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  discoverAnchor as discoverRegistryAnchor,
  Sep1DiscoveryError,
  type Sep1ErrorCode,
} from "@/lib/stellar/sep1";
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
  const { db } = await import("@/lib/db");
  const data = {
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    tomlUrl: anchor.tomlUrl,
    seps: [...anchor.seps],
    isTransferCapable: anchor.isTransferCapable,
    status: AnchorStatus.LIVE,
  };

  const persisted = await db.anchor.upsert({
    where: { slug: anchor.slug },
    create: { slug: anchor.slug, ...data },
    update: data,
    select: ANCHOR_SELECT,
  });

  return freezePersistedAnchor(persisted);
}

export async function markAnchorDownIfExists(slug: string): Promise<boolean> {
  const { db } = await import("@/lib/db");
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
      await dependencies.persist(discovered);
      successfulSlugs.push(entry.slug);
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

function freezePersistedAnchor(anchor: {
  slug: string;
  name: string;
  homeDomain: string;
  tomlUrl: string;
  seps: number[];
  isTransferCapable: boolean;
  status: AnchorStatus;
}): PersistedAnchor {
  return Object.freeze({
    ...anchor,
    seps: Object.freeze([...anchor.seps]),
  });
}
