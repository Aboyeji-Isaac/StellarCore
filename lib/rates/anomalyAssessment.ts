import { assessRateAnomalies } from "@/lib/rates/anomaly";
import { selectLatestPerAnchor } from "@/lib/rates/latestRateReadModel";
import { PRISMA_LATEST_RATE_REPOSITORY } from "@/lib/rates/latestRateRepository";
import type { LatestRateRepository } from "@/types/latestRates";
import type {
  CorridorAnomalyAssessmentSummary,
  RateAnomalyAssessment,
  RateAnomalyDiagnostic,
  RateAnomalyStatus,
} from "@/types/rates";

export type { CorridorAnomalyAssessmentSummary } from "@/types/rates";

export type RateAnomalyAssessmentRepository = Readonly<{
  appendAssessments: (
    rows: readonly Readonly<RateAnomalyAssessment & { assessedAt: Date }>[],
  ) => Promise<void>;
}>;

/**
 * Re-assesses the latest observation per anchor for each corridor and appends
 * a row only when the verdict for a snapshot changes (or it has none yet).
 * Rows are never updated or deleted, so a later recovery from quarantine is
 * recorded next to the quarantine it supersedes. A failure is isolated per
 * corridor; the read model then applies the same criterion at read time.
 */
export async function assessCorridorAnomalies(
  corridorSlugs: readonly string[],
  dependencies: Readonly<{
    latest?: LatestRateRepository;
    assessments?: RateAnomalyAssessmentRepository;
    now?: () => Date;
  }> = {},
): Promise<CorridorAnomalyAssessmentSummary> {
  const latestRepository = dependencies.latest ?? PRISMA_LATEST_RATE_REPOSITORY;
  const assessmentRepository = dependencies.assessments ?? PRISMA_RATE_ANOMALY_ASSESSMENT_REPOSITORY;
  const quarantined: RateAnomalyDiagnostic[] = [];
  const failures: { corridorSlug: string; code: "ANOMALY_ASSESSMENT_FAILURE" }[] = [];
  let corridorsAssessed = 0;
  let assessmentsAppended = 0;

  for (const corridorSlug of [...new Set(corridorSlugs)].sort()) {
    try {
      const corridor = await latestRepository.findCorridorBySlug(corridorSlug);
      if (!corridor) throw new Error("CORRIDOR_NOT_FOUND");
      const latest = selectLatestPerAnchor(
        await latestRepository.findLatestObservations(corridor.id),
      );
      const verdicts = assessRateAnomalies(latest.map((observation) => ({
        id: observation.id,
        independenceKey: observation.anchorSlug,
        rate: observation.rate,
        capturedAt: observation.capturedAt,
      })));
      const assessedAt = dependencies.now?.() ?? new Date();
      const changed = verdicts.filter((verdict, index) => {
        const previous = latest[index]!.anomaly;
        return !previous || previous.status !== verdict.status || previous.reason !== verdict.reason;
      });
      if (changed.length > 0) {
        await assessmentRepository.appendAssessments(
          changed.map((verdict) => Object.freeze({ ...verdict, assessedAt })),
        );
      }
      corridorsAssessed += 1;
      assessmentsAppended += changed.length;
      verdicts.forEach((verdict, index) => {
        if (verdict.status !== "quarantined") return;
        quarantined.push(Object.freeze({
          snapshotId: verdict.observationId,
          anchorSlug: latest[index]!.anchorSlug,
          corridorSlug,
          status: verdict.status,
          reason: verdict.reason,
          baselineRate: verdict.baselineRate,
          independentPeerCount: verdict.independentPeerCount,
          agreeingPeerCount: verdict.agreeingPeerCount,
          toleranceBps: verdict.toleranceBps,
        }));
      });
    } catch {
      failures.push(Object.freeze({ corridorSlug, code: "ANOMALY_ASSESSMENT_FAILURE" }));
    }
  }

  return Object.freeze({
    corridorsAssessed,
    assessmentsAppended,
    quarantined: Object.freeze(quarantined),
    failures: Object.freeze(failures),
  });
}

export const PRISMA_RATE_ANOMALY_ASSESSMENT_REPOSITORY: RateAnomalyAssessmentRepository =
  Object.freeze({
    async appendAssessments(rows) {
      const { db } = await import("@/lib/dbClient");
      await db.rateAnomalyAssessment.createMany({
        data: rows.map((row) => ({
          snapshotId: row.observationId,
          status: PRISMA_STATUS[row.status],
          reason: row.reason,
          criterionVersion: row.criterionVersion,
          baselineRate: row.baselineRate,
          toleranceBps: row.toleranceBps,
          contemporaneityWindowMs: row.contemporaneityWindowMs,
          independentPeerCount: row.independentPeerCount,
          agreeingPeerCount: row.agreeingPeerCount,
          peerSnapshotIds: [...row.peerObservationIds],
          assessedAt: row.assessedAt,
        })),
      });
    },
  });

const PRISMA_STATUS = Object.freeze({
  consistent: "CONSISTENT",
  quarantined: "QUARANTINED",
  insufficient_peers: "INSUFFICIENT_PEERS",
  unassessable: "UNASSESSABLE",
} as const satisfies Record<RateAnomalyStatus, string>);
