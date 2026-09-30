import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import {
  assessObservation,
  buildSep1Observation,
  diffSensitiveMetadata,
  extractSensitiveMetadata,
  isSha256Digest,
  type CanonicalSep1SensitiveMetadata,
  type Sep1Assessment,
  type Sep1FieldDiff,
  type Sep1Observation,
} from "@/lib/stellar/sep1History";
import type { DiscoveredAnchor } from "@/types/anchor";

export type Sep1HistoryDb = PrismaClient | Prisma.TransactionClient;

export type Sep1ReviewDecisionValue = "APPROVED" | "REJECTED";

export type Sep1ReviewInput = Readonly<{
  anchorSlug: string;
  observationDigest: string;
  decision: Sep1ReviewDecisionValue;
  actor: string;
  reference: string;
  reason: string;
}>;

export type Sep1ReviewErrorCode =
  | "ANCHOR_NOT_FOUND"
  | "OBSERVATION_NOT_FOUND"
  | "INVALID_DIGEST"
  | "INVALID_REVIEW_FIELD";

export class Sep1ReviewError extends Error {
  constructor(readonly code: Sep1ReviewErrorCode) {
    super(code);
    this.name = "Sep1ReviewError";
  }
}

/**
 * Where an anchor stands with respect to review. This is deliberately separate
 * from discovery failure (parse/network errors never create observations) and
 * from registry retirement or anchor availability status.
 */
export type Sep1BaselineState =
  | Readonly<{ state: "UNAVAILABLE" }>
  | Readonly<{
      state: "APPROVED";
      reviewId: string;
      observationDigest: string;
      sensitiveDigest: string;
      reviewedAt: Date;
      sensitive: CanonicalSep1SensitiveMetadata;
    }>;

export type RecordedSep1Observation = Readonly<{
  observationId: string;
  digest: string;
  sensitiveDigest: string;
  assessment: Sep1Assessment;
  diff: readonly Sep1FieldDiff[];
}>;

const MAX_ACTOR = 100;
const MAX_REFERENCE = 200;
const MAX_REASON = 1000;

/** Newest APPROVED review's observation, or UNAVAILABLE (never inferred). */
export async function getApprovedBaseline(
  db: Sep1HistoryDb,
  anchorId: string,
): Promise<Sep1BaselineState> {
  const review = await db.sep1MetadataReview.findFirst({
    where: { anchorId, decision: "APPROVED" },
    orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
    include: { observation: { select: { metadata: true, canonicalVersion: true } } },
  });
  if (!review) return Object.freeze({ state: "UNAVAILABLE" as const });

  return Object.freeze({
    state: "APPROVED" as const,
    reviewId: review.id,
    observationDigest: review.observationDigest,
    sensitiveDigest: review.sensitiveDigest,
    reviewedAt: review.reviewedAt,
    sensitive: sensitiveFromStoredMetadata(review.observation.metadata),
  });
}

/**
 * Appends one immutable observation for a successful discovery and reports how
 * it compares with the approved baseline. Never mutates existing rows.
 */
export async function recordSep1Observation(
  db: Sep1HistoryDb,
  anchorId: string,
  discovered: DiscoveredAnchor,
  observation: Sep1Observation = buildSep1Observation(discovered),
): Promise<RecordedSep1Observation> {
  const baseline = await getApprovedBaseline(db, anchorId);
  const { assessment, diff } = assessObservation(
    baseline.state === "APPROVED" ? baseline.sensitive : null,
    observation,
  );

  const row = await db.sep1DiscoveryObservation.create({
    data: {
      anchorId,
      canonicalVersion: observation.version,
      digest: observation.digest,
      sensitiveDigest: observation.sensitiveDigest,
      tomlUrl: discovered.tomlUrl,
      metadata: observation.metadata as unknown as Prisma.InputJsonValue,
      assessment,
      diff: diff as unknown as Prisma.InputJsonValue,
      baselineReviewId: baseline.state === "APPROVED" ? baseline.reviewId : null,
    },
    select: { id: true },
  });

  return Object.freeze({
    observationId: row.id,
    digest: observation.digest,
    sensitiveDigest: observation.sensitiveDigest,
    assessment,
    diff,
  });
}

/**
 * Read-only check used by rate capture: is a fresh discovery consistent with
 * the approved baseline? Returns the assessment without writing.
 */
export async function assessAgainstApprovedBaseline(
  db: Sep1HistoryDb,
  anchorSlug: string,
  discovered: DiscoveredAnchor,
): Promise<
  Readonly<{
    assessment: Sep1Assessment;
    diff: readonly Sep1FieldDiff[];
    digest: string;
  }>
> {
  const observation = buildSep1Observation(discovered);
  const anchor = await db.anchor.findUnique({
    where: { slug: anchorSlug },
    select: { id: true },
  });
  const baseline = anchor
    ? await getApprovedBaseline(db, anchor.id)
    : ({ state: "UNAVAILABLE" } as const);
  const { assessment, diff } = assessObservation(
    baseline.state === "APPROVED" ? baseline.sensitive : null,
    observation,
  );

  return Object.freeze({ assessment, diff, digest: observation.digest });
}

/**
 * Appends an APPROVED/REJECTED review for one specific observation digest of
 * one anchor. `reviewedFields` are the sensitive fields that differ from the
 * baseline in force at review time (all populated fields when none exists).
 */
export async function reviewSep1Observation(
  db: PrismaClient,
  input: Sep1ReviewInput,
) {
  if (!isSha256Digest(input.observationDigest)) {
    throw new Sep1ReviewError("INVALID_DIGEST");
  }
  const actor = boundedField(input.actor, MAX_ACTOR);
  const reference = boundedField(input.reference, MAX_REFERENCE);
  const reason = boundedField(input.reason, MAX_REASON);

  return db.$transaction(async (tx) => {
    const anchor = await tx.anchor.findUnique({
      where: { slug: input.anchorSlug },
      select: { id: true },
    });
    if (!anchor) throw new Sep1ReviewError("ANCHOR_NOT_FOUND");

    const observation = await tx.sep1DiscoveryObservation.findFirst({
      where: { anchorId: anchor.id, digest: input.observationDigest },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    });
    if (!observation) throw new Sep1ReviewError("OBSERVATION_NOT_FOUND");

    const baseline = await getApprovedBaseline(tx, anchor.id);
    const diff = diffSensitiveMetadata(
      baseline.state === "APPROVED" ? baseline.sensitive : null,
      sensitiveFromStoredMetadata(observation.metadata),
    );

    return tx.sep1MetadataReview.create({
      data: {
        anchorId: anchor.id,
        observationId: observation.id,
        observationDigest: observation.digest,
        sensitiveDigest: observation.sensitiveDigest,
        decision: input.decision,
        actor,
        reference,
        reason,
        reviewedFields: diff.map(({ field }) => field),
      },
    });
  });
}

export async function listSep1Observations(
  db: Sep1HistoryDb,
  anchorSlug: string,
  limit = 20,
) {
  const anchor = await db.anchor.findUnique({
    where: { slug: anchorSlug },
    select: { id: true },
  });
  if (!anchor) throw new Sep1ReviewError("ANCHOR_NOT_FOUND");

  const [baseline, observations, reviews] = await Promise.all([
    getApprovedBaseline(db, anchor.id),
    db.sep1DiscoveryObservation.findMany({
      where: { anchorId: anchor.id },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        digest: true,
        sensitiveDigest: true,
        assessment: true,
        diff: true,
        fetchedAt: true,
      },
    }),
    db.sep1MetadataReview.findMany({
      where: { anchorId: anchor.id },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        observationDigest: true,
        decision: true,
        actor: true,
        reference: true,
        reason: true,
        reviewedFields: true,
        reviewedAt: true,
      },
    }),
  ]);

  return { baseline, observations, reviews };
}

function boundedField(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Sep1ReviewError("INVALID_REVIEW_FIELD");
  }
  return trimmed;
}

function sensitiveFromStoredMetadata(
  metadata: unknown,
): CanonicalSep1SensitiveMetadata {
  // Re-derive from the stored canonical metadata so the baseline can never
  // drift from what the digest covered.
  return extractSensitiveMetadata(
    metadata as Parameters<typeof extractSensitiveMetadata>[0],
  );
}
