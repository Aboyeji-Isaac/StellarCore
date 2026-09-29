import {
  planDisposition,
  stateAfterAction,
  validateDispositionRequest,
  type DispositionErrorCode,
  type DispositionState,
} from "@/lib/rates/disposition";
import {
  PRISMA_DISPOSITION_REPOSITORY,
  type DispositionEventRecord,
  type DispositionRepository,
  type DispositionSnapshotRecord,
} from "@/lib/rates/dispositionRepository";

export type SnapshotSummary = Readonly<{
  snapshotId: string;
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: string;
  state: DispositionState;
  reviewed: boolean;
}>;

export type DispositionToolResult =
  | Readonly<{
      ok: true;
      mode: "dry-run" | "applied";
      snapshot: SnapshotSummary;
      fromState: DispositionState;
      toState: DispositionState;
      sequence: number;
      event?: DispositionEventRecord;
    }>
  | Readonly<{ ok: false; code: DispositionErrorCode }>;

/**
 * Plans (dry run) or records (apply) one disposition. Dry run performs the
 * same validation and database checks as apply but writes nothing. Apply
 * appends exactly one event and never touches the rate snapshot.
 */
export async function runDisposition(
  input: Readonly<Record<string, unknown>>,
  options: Readonly<{ apply: boolean; repository?: DispositionRepository }>,
): Promise<DispositionToolResult> {
  const validation = validateDispositionRequest(input);
  if (!validation.ok) return validation;
  const { request } = validation;
  const repository = options.repository ?? PRISMA_DISPOSITION_REPOSITORY;

  try {
    return await repository.withTransaction(async (tx) => {
      const target = await tx.findSnapshot(request.snapshotId);
      const replacement = request.supersededBySnapshotId
        ? await tx.findSnapshot(request.supersededBySnapshotId)
        : null;
      const plan = planDisposition(request, target, replacement);
      if (!plan.ok) return plan;
      const snapshot = summarize(target as DispositionSnapshotRecord);

      if (!options.apply) {
        return Object.freeze({ ok: true, mode: "dry-run", snapshot, ...pick(plan) });
      }
      const event = await tx.append({
        snapshotId: request.snapshotId,
        sequence: plan.sequence,
        action: request.action,
        reasonCode: request.reasonCode,
        reviewReference: request.reviewReference,
        actor: request.actor,
        ...(request.note ? { note: request.note } : {}),
        ...(request.supersededBySnapshotId
          ? { supersededBySnapshotId: request.supersededBySnapshotId }
          : {}),
      });
      return Object.freeze({ ok: true, mode: "applied", snapshot, ...pick(plan), event });
    });
  } catch (error) {
    return Object.freeze({ ok: false, code: classifyPersistenceError(error) });
  }
}

export type InspectionResult =
  | Readonly<{ ok: true; snapshot: SnapshotSummary; events: readonly DispositionEventRecord[] }>
  | Readonly<{ ok: false; code: "INVALID_SNAPSHOT_ID" | "SNAPSHOT_NOT_FOUND" | "PERSISTENCE_FAILURE" }>;

export async function inspectSnapshot(
  snapshotId: string,
  repository: DispositionRepository = PRISMA_DISPOSITION_REPOSITORY,
): Promise<InspectionResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId)) {
    return Object.freeze({ ok: false, code: "INVALID_SNAPSHOT_ID" });
  }
  try {
    const snapshot = await repository.findSnapshot(snapshotId.toLowerCase());
    if (!snapshot) return Object.freeze({ ok: false, code: "SNAPSHOT_NOT_FOUND" });
    return Object.freeze({ ok: true, snapshot: summarize(snapshot), events: snapshot.events });
  } catch {
    return Object.freeze({ ok: false, code: "PERSISTENCE_FAILURE" });
  }
}

function summarize(snapshot: DispositionSnapshotRecord): SnapshotSummary {
  return Object.freeze({
    snapshotId: snapshot.id,
    anchorSlug: snapshot.anchorSlug,
    corridorSlug: snapshot.corridorSlug,
    rate: snapshot.rate,
    capturedAt: snapshot.capturedAt.toISOString(),
    state: stateAfterAction(snapshot.lastAction),
    // Only an explicit event means a maintainer reviewed the observation.
    reviewed: snapshot.events.length > 0,
  });
}

function pick(plan: Readonly<{ sequence: number; fromState: DispositionState; toState: DispositionState }>) {
  return { fromState: plan.fromState, toState: plan.toState, sequence: plan.sequence };
}

/** Maps database failures to bounded codes without echoing messages. */
export function classifyPersistenceError(error: unknown): DispositionErrorCode {
  const code = (error as { code?: unknown })?.code;
  // Unique (snapshot, sequence) or serialization conflicts: another operator
  // recorded a disposition concurrently. Re-inspect and retry.
  if (code === "P2002" || code === "P2034") return "CONCURRENT_MODIFICATION";
  const text = String((error as { message?: unknown })?.message ?? "");
  if (/could not serialize|40001|23505/.test(text)) return "CONCURRENT_MODIFICATION";
  if (/23514|check_violation|violates check constraint|append-only/.test(text)) return "REJECTED_BY_DATABASE";
  return "PERSISTENCE_FAILURE";
}
