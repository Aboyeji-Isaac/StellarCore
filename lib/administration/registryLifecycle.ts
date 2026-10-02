import { buildOperatorActionPreview } from "@/lib/audit/recordOperatorAction";
import { validateOperatorActionInput } from "@/lib/audit/validation";
import type {
  AnchorLifecycleState,
  AnchorLifecycleTarget,
  RegistryLifecycleOutcome,
  RegistryLifecycleRejectionCode,
  RegistryLifecycleRequest,
} from "@/types/administration";
import type { OperatorActionRecord, RecordOperatorActionInput } from "@/types/audit";

export type ApplyAnchorLifecycleInput = Readonly<{
  anchor: AnchorLifecycleTarget;
  nextState: AnchorLifecycleState;
  action: RecordOperatorActionInput;
}>;

/**
 * Repository contract. `applyLifecycleChange` must update the anchor's reviewed
 * lifecycle state and append the ledger row in one transaction.
 */
export type RegistryLifecycleRepository = Readonly<{
  findAnchor: (slug: string) => Promise<AnchorLifecycleTarget | null>;
  applyLifecycleChange: (input: ApplyAnchorLifecycleInput) => Promise<
    | Readonly<{ ok: true; anchor: AnchorLifecycleTarget; action: OperatorActionRecord }>
    | Readonly<{ ok: false; code: "STATE_CONFLICT" | "TARGET_NOT_FOUND" }>
  >;
}>;

export type RegistryLifecycleDependencies = Readonly<{
  repository: RegistryLifecycleRepository;
}>;

type LifecycleTransition = "retire" | "reactivate";

export async function runRegistryRetirement(
  request: RegistryLifecycleRequest,
  dependencies: RegistryLifecycleDependencies,
): Promise<RegistryLifecycleOutcome> {
  return runLifecycleTransition(request, dependencies, "retire");
}

export async function runRegistryReactivation(
  request: RegistryLifecycleRequest,
  dependencies: RegistryLifecycleDependencies,
): Promise<RegistryLifecycleOutcome> {
  return runLifecycleTransition(request, dependencies, "reactivate");
}

async function runLifecycleTransition(
  request: RegistryLifecycleRequest,
  dependencies: RegistryLifecycleDependencies,
  transition: LifecycleTransition,
): Promise<RegistryLifecycleOutcome> {
  const slug = request.anchorSlug?.trim() ?? "";
  if (slug.length === 0) return rejected("INVALID_INPUT");

  const anchor = await dependencies.repository.findAnchor(slug);
  if (!anchor) return rejected("TARGET_NOT_FOUND");

  const requiredState: AnchorLifecycleState = transition === "retire" ? "ACTIVE" : "RETIRED";
  if (anchor.lifecycleState !== requiredState) {
    return rejected(transition === "retire" ? "ALREADY_RETIRED" : "NOT_RETIRED");
  }

  const nextState: AnchorLifecycleState = transition === "retire" ? "RETIRED" : "ACTIVE";
  const actionInput: RecordOperatorActionInput = {
    ...(request.actionId !== undefined ? { actionId: request.actionId } : {}),
    actionType: transition === "retire" ? "ANCHOR_RETIRED" : "ANCHOR_REACTIVATED",
    targetType: "ANCHOR",
    targetId: anchor.anchorId,
    targetLabel: anchor.slug,
    reasonCode: request.reasonCode,
    ...(request.rationale !== undefined ? { rationale: request.rationale } : {}),
    actor: request.actor,
    ...(request.runId !== undefined ? { runId: request.runId } : {}),
  };

  if (validateOperatorActionInput(actionInput).length > 0) {
    return rejected("INVALID_INPUT");
  }

  if (request.mode === "dry-run") {
    return Object.freeze({
      status: "dry_run",
      anchor,
      action: buildOperatorActionPreview(actionInput),
    });
  }

  const applied = await dependencies.repository.applyLifecycleChange({
    anchor,
    nextState,
    action: actionInput,
  });

  if (!applied.ok) {
    if (applied.code === "TARGET_NOT_FOUND") return rejected("TARGET_NOT_FOUND");
    return rejected(transition === "retire" ? "ALREADY_RETIRED" : "NOT_RETIRED");
  }

  return Object.freeze({ status: "applied", anchor: applied.anchor, action: applied.action });
}

function rejected(
  code: RegistryLifecycleRejectionCode,
): Extract<RegistryLifecycleOutcome, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", code });
}
