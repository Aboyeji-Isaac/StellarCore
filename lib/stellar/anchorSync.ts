import { getDbForWorkload, MAINTENANCE_WORKLOAD } from "@/lib/db/workloadAccessor";
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
  | "STALE_WRITE_REJECTED"
  | "UNEXPECTED_ERROR";

export type AnchorSyncFailure = Readonly<{
  slug: string;
  phase: "DISCOVERY" | "PERSISTENCE";
  code: AnchorSyncFailureCode;
  statusUpdate: "MARKED_DOWN" | "NOT_FOUND" | "FAILED" | "STALE" | "NOT_ATTEMPTED";
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
  allocateOrder: () => Promise<bigint>;
  persist: (anchor: DiscoveredAnchor, order: bigint) => Promise<PersistedAnchor | null>;
  markDown: (slug: string, order: bigint) => Promise<"MARKED_DOWN" | "NOT_FOUND" | "STALE">;
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
  order: bigint,
): Promise<PersistedAnchor | null> {
  const db = getDbForWorkload(MAINTENANCE_WORKLOAD);
  const affected = await db.$executeRaw`
    INSERT INTO anchors (slug, name, home_domain, toml_url, seps, is_transfer_capable, status, last_sync_order)
    VALUES (${anchor.slug}, ${anchor.name}, ${anchor.homeDomain}, ${anchor.tomlUrl}, ${[...anchor.seps]}, ${anchor.isTransferCapable}, 'LIVE'::anchor_status, ${order})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, home_domain = EXCLUDED.home_domain,
      toml_url = EXCLUDED.toml_url, seps = EXCLUDED.seps, is_transfer_capable = EXCLUDED.is_transfer_capable,
      status = EXCLUDED.status, last_sync_order = EXCLUDED.last_sync_order, updated_at = CURRENT_TIMESTAMP
    WHERE anchors.last_sync_order < EXCLUDED.last_sync_order
  `;
  if (affected === 0) return null;
  const persisted = await db.anchor.findUniqueOrThrow({ where: { slug: anchor.slug }, select: ANCHOR_SELECT });
  return freezePersistedAnchor(persisted);
}

export async function allocateAnchorSyncOrder(): Promise<bigint> {
  const db = getDbForWorkload(MAINTENANCE_WORKLOAD);
  const rows = await db.$queryRaw<[{ order: bigint }]>`SELECT nextval('anchor_sync_order_seq') AS order`;
  return rows[0]!.order;
}

export async function markAnchorDownIfExists(slug: string, order: bigint): Promise<"MARKED_DOWN" | "NOT_FOUND" | "STALE"> {
  const db = getDbForWorkload(MAINTENANCE_WORKLOAD);
  const result = await db.anchor.updateMany({
    where: { slug, lastSyncOrder: { lt: order } },
    data: { status: AnchorStatus.DOWN, lastSyncOrder: order },
  });

  if (result.count > 0) return "MARKED_DOWN";
  return await db.anchor.findUnique({ where: { slug }, select: { slug: true } }) ? "STALE" : "NOT_FOUND";
}

export async function syncAnchorRegistry(
  entries: readonly AnchorRegistryEntry[] = ANCHOR_REGISTRY,
  dependencies: AnchorSyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
): Promise<AnchorSyncResult> {
  const order = await dependencies.allocateOrder();
  const successfulSlugs: string[] = [];
  const failures: AnchorSyncFailure[] = [];

  for (const entry of entries) {
    let discovered: DiscoveredAnchor;

    try {
      discovered = await dependencies.discover(entry);
    } catch (error) {
      const code = classifyDiscoveryFailure(error);
      failures.push(
        Object.freeze({
          slug: entry.slug,
          phase: "DISCOVERY",
          code,
          statusUpdate:
            code === "EGRESS_POLICY"
              ? "NOT_ATTEMPTED"
              : await safelyMarkDown(entry.slug, order, dependencies.markDown),
        }),
      );
      continue;
    }

    try {
      const persisted = await dependencies.persist(discovered, order);
      if (persisted) successfulSlugs.push(entry.slug);
      else failures.push(Object.freeze({ slug: entry.slug, phase: "PERSISTENCE", code: "STALE_WRITE_REJECTED", statusUpdate: "NOT_ATTEMPTED" }));
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
  allocateOrder: allocateAnchorSyncOrder,
  persist: persistDiscoveredAnchor,
  markDown: markAnchorDownIfExists,
}) satisfies AnchorSyncDependencies;

function classifyDiscoveryFailure(error: unknown): AnchorSyncFailureCode {
  return error instanceof Sep1DiscoveryError ? error.code : "UNEXPECTED_ERROR";
}

async function safelyMarkDown(
  slug: string,
  order: bigint,
  markDown: AnchorSyncDependencies["markDown"],
): Promise<AnchorSyncFailure["statusUpdate"]> {
  try {
    return await markDown(slug, order);
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
