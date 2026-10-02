import { AnchorStatus } from "@/app/generated/prisma/enums";
import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  applyAnchorHealthObservation,
  classifyAnchorFailure,
  initialAnchorHealthState,
} from "@/lib/stellar/anchorHealth";
import {
  discoverAnchor as discoverRegistryAnchor,
  Sep1DiscoveryError,
  type Sep1ErrorCode,
} from "@/lib/stellar/sep1";
import type {
  AnchorRegistryEntry,
  DiscoveredAnchor,
} from "@/types/anchor";
import type {
  AnchorEvidenceOutcome,
  AnchorFailureClass,
  AnchorHealthState,
  AnchorHealthTransition,
  AnchorStatusTransition,
} from "@/types/anchorHealth";

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
  transitions: readonly AnchorStatusTransition[];
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

/**
 * Persists a successfully discovered anchor. The anchor's metadata reflects
 * the last complete, validated discovery; the health status is owned by the
 * health state machine, so persistence does not reset it.
 */
export async function persistDiscoveredAnchor(
  anchor: DiscoveredAnchor,
  order: bigint,
): Promise<PersistedAnchor | null> {
  const { db } = await import("@/lib/dbClient");
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
  const { db } = await import("@/lib/dbClient");
  const rows = await db.$queryRaw<[{ order: bigint }]>`SELECT nextval('anchor_sync_order_seq') AS order`;
  return rows[0]!.order;
}

export async function markAnchorDownIfExists(slug: string, order: bigint): Promise<"MARKED_DOWN" | "NOT_FOUND" | "STALE"> {
  const { db } = await import("@/lib/dbClient");
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
  const transitions: AnchorStatusTransition[] = [];

  for (const entry of entries) {
    let discovered: DiscoveredAnchor;

    try {
      discovered = await dependencies.discover(entry);
    } catch (error) {
      const failureClass = classifyAnchorFailure(error);
      const code = classifyDiscoveryFailure(error);

      const code = classifyDiscoveryFailure(error);
      failures.push(
        Object.freeze({
          slug: entry.slug,
          phase: "DISCOVERY",
          code,
          statusUpdate: await safelyRecordFailure(
            entry.slug,
            failureClass,
            code,
            dependencies.recordFailure,
            transitions,
          ),
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
      // Persistence failure is an internal problem, never anchor evidence:
      // it must not affect the anchor's published health status.
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
    transitions: Object.freeze(transitions),
  });
}

const DEFAULT_SYNC_DEPENDENCIES = Object.freeze({
  discover: discoverRegistryAnchor,
  allocateOrder: allocateAnchorSyncOrder,
  persist: persistDiscoveredAnchor,
  recordSuccess: recordAnchorSuccessEvidence,
  recordFailure: recordAnchorFailureEvidence,
}) satisfies AnchorSyncDependencies;

function classifyDiscoveryFailure(error: unknown): AnchorSyncFailureCode {
  return error instanceof Sep1DiscoveryError ? error.code : "UNEXPECTED_ERROR";
}

async function safelyRecordSuccess(
  slug: string,
  recordSuccess: AnchorSyncDependencies["recordSuccess"],
): Promise<AnchorEvidenceOutcome> {
  try {
    return await recordSuccess(slug);
  } catch {
    return { kind: "RECORDED", status: AnchorStatus.LIVE, statusChanged: false };
  }
}

async function safelyRecordFailure(
  slug: string,
  order: bigint,
  markDown: AnchorSyncDependencies["markDown"],
): Promise<AnchorSyncFailure["statusUpdate"]> {
  let outcome: AnchorEvidenceOutcome;

  try {
    return await markDown(slug, order);
  } catch {
    return "FAILED";
  }

  if (outcome.kind === "ANCHOR_NOT_FOUND") return "ANCHOR_NOT_FOUND";

  pushTransition(transitions, slug, outcome);

  switch (outcome.status) {
    case AnchorStatus.DOWN:
      return "PUBLISHED_DOWN";
    case AnchorStatus.DEGRADED:
      return "PUBLISHED_DEGRADED";
    default:
      // LIVE or UNKNOWN after a failure means the evidence threshold was not
      // met: the published status is unchanged and no destructive transition
      // was published.
      return "RECORDED_EVIDENCE";
  }
}

function pushTransition(
  transitions: AnchorStatusTransition[],
  slug: string,
  outcome: AnchorEvidenceOutcome,
): void {
  if (outcome.kind === "RECORDED" && outcome.statusChanged) {
    transitions.push(Object.freeze({ slug, status: outcome.status, statusChanged: true }));
  }
}

/**
 * Records one failed discovery as bounded health evidence in one transaction
 * with the published status update. The pure state machine decides the
 * transition; this function only persists it, so the result is deterministic
 * across process restarts and horizontal execution.
 */
export async function recordAnchorFailureEvidence(
  slug: string,
  failureClass: AnchorFailureClass,
  failureCode: string,
): Promise<AnchorEvidenceOutcome> {
  const { db } = await import("@/lib/dbClient");

  return db.$transaction(async (transaction) => {
    const anchor = await transaction.anchor.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });

    if (!anchor) return { kind: "ANCHOR_NOT_FOUND" };

    const current = await loadHealthState(transaction, slug, anchor.status, anchor.id);
    const transition = applyAnchorHealthObservation(current, {
      outcome: "FAILURE",
      occurredAt: new Date(),
      failure: { failureClass, code: failureCode },
    });

    await saveHealthState(transaction, anchor.id, transition);

    if (transition.statusChanged) {
      await transaction.anchor.update({
        where: { id: anchor.id },
        data: { status: transition.status },
      });
    }

    return {
      kind: "RECORDED",
      status: transition.status,
      statusChanged: transition.statusChanged,
    };
  });
}

/**
 * Records one successful discovery as bounded health evidence. Called after
 * metadata persistence, so recovery evidence exists only when the anchor row
 * was actually written.
 */
export async function recordAnchorSuccessEvidence(
  slug: string,
): Promise<AnchorEvidenceOutcome> {
  const { db } = await import("@/lib/dbClient");

  return db.$transaction(async (transaction) => {
    const anchor = await transaction.anchor.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });

    if (!anchor) return { kind: "ANCHOR_NOT_FOUND" };

    const current = await loadHealthState(transaction, slug, anchor.status, anchor.id);
    const transition = applyAnchorHealthObservation(current, {
      outcome: "SUCCESS",
      occurredAt: new Date(),
    });

    await saveHealthState(transaction, anchor.id, transition);

    if (transition.statusChanged) {
      await transaction.anchor.update({
        where: { id: anchor.id },
        data: { status: transition.status },
      });
    }

    return {
      kind: "RECORDED",
      status: transition.status,
      statusChanged: transition.statusChanged,
    };
  });
}

type PrismaDb = Awaited<typeof import("@/lib/dbClient")>["db"];
type HealthTransaction = Parameters<Parameters<PrismaDb["$transaction"]>[0]>[0];

async function loadHealthState(
  transaction: HealthTransaction,
  slug: string,
  anchorStatus: AnchorStatus,
  anchorId: string,
): Promise<AnchorHealthState> {
  const health = await transaction.anchorHealthState.findUnique({
    where: { anchorId },
  });

  if (!health) {
    // Seed the machine with the anchor's published status so the first
    // observation after this migration continues from the known state
    // instead of inventing an UNKNOWN history.
    return {
      ...initialAnchorHealthState(slug),
      status: anchorStatus,
    };
  }

  return {
    anchorSlug: slug,
    status: health.status,
    consecutiveFailures: health.consecutiveFailures,
    lastFailureClass: normalizeFailureClass(health.lastFailureClass),
    lastFailureCode: health.lastFailureCode,
    consecutiveSuccesses: health.consecutiveSuccesses,
    lastObservedAt: health.lastObservedAt,
    lastSuccessAt: health.lastSuccessAt,
    lastFailureAt: health.lastFailureAt,
    lastTransitionAt: health.lastTransitionAt,
  };
}

function normalizeFailureClass(
  value: string | null,
): AnchorHealthState["lastFailureClass"] {
  return value === "TRANSIENT" || value === "DETERMINISTIC" || value === "UNKNOWN"
    ? value
    : null;
}

async function saveHealthState(
  transaction: HealthTransaction,
  anchorId: string,
  transition: AnchorHealthTransition,
): Promise<void> {
  await transaction.anchorHealthState.upsert({
    where: { anchorId },
    create: { anchorId, ...healthRowData(transition) },
    update: healthRowData(transition),
  });
}

function healthRowData(transition: AnchorHealthTransition) {
  const evidence = transition.next;

  return {
    status: transition.status,
    consecutiveFailures: evidence.consecutiveFailures,
    lastFailureClass: evidence.lastFailureClass,
    lastFailureCode: evidence.lastFailureCode,
    consecutiveSuccesses: evidence.consecutiveSuccesses,
    lastObservedAt: evidence.lastObservedAt,
    lastSuccessAt: evidence.lastSuccessAt,
    lastFailureAt: evidence.lastFailureAt,
    lastTransitionAt: evidence.lastTransitionAt,
  };
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
