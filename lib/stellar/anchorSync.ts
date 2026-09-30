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
  | "UNEXPECTED_ERROR";

export type AnchorSyncFailure = Readonly<{
  slug: string;
  phase: "DISCOVERY" | "PERSISTENCE";
  code: AnchorSyncFailureCode;
  /**
   * Evidence-based observational outcome for this anchor's published status.
   * A discovery failure records bounded evidence and publishes a destructive
   * status only when the documented hysteresis thresholds are met; it never
   * flips a healthy anchor on one transient error.
   */
  statusUpdate:
    | "RECORDED_EVIDENCE"
    | "PUBLISHED_DEGRADED"
    | "PUBLISHED_DOWN"
    | "ANCHOR_NOT_FOUND"
    | "FAILED"
    | "NOT_ATTEMPTED";
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
  persist: (anchor: DiscoveredAnchor) => Promise<PersistedAnchor>;
  recordSuccess: (slug: string) => Promise<AnchorEvidenceOutcome>;
  recordFailure: (
    slug: string,
    failureClass: AnchorFailureClass,
    failureCode: string,
  ) => Promise<AnchorEvidenceOutcome>;
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
): Promise<PersistedAnchor> {
  const { db } = await import("@/lib/dbClient");
  const data = {
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    tomlUrl: anchor.tomlUrl,
    seps: [...anchor.seps],
    isTransferCapable: anchor.isTransferCapable,
  };

  const persisted = await db.anchor.upsert({
    where: { slug: anchor.slug },
    create: { slug: anchor.slug, ...data, status: AnchorStatus.LIVE },
    update: data,
    select: ANCHOR_SELECT,
  });

  return freezePersistedAnchor(persisted);
}

export async function syncAnchorRegistry(
  entries: readonly AnchorRegistryEntry[] = ANCHOR_REGISTRY,
  dependencies: AnchorSyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
): Promise<AnchorSyncResult> {
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
        }),
      );
      continue;
    }

    try {
      await dependencies.persist(discovered);
      const outcome = await safelyRecordSuccess(
        entry.slug,
        dependencies.recordSuccess,
      );

      successfulSlugs.push(entry.slug);
      pushTransition(transitions, entry.slug, outcome);
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
  failureClass: AnchorFailureClass,
  failureCode: string,
  recordFailure: AnchorSyncDependencies["recordFailure"],
  transitions: AnchorStatusTransition[],
): Promise<AnchorSyncFailure["statusUpdate"]> {
  let outcome: AnchorEvidenceOutcome;

  try {
    outcome = await recordFailure(slug, failureClass, failureCode);
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
