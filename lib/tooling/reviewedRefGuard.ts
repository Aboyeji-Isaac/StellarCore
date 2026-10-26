/**
 * Reviewed-ref guard for production mutation workflows (issue #354).
 *
 * Issue #146 hardens manual workflows that can mutate production evidence. A
 * workflow must reject an unapproved source ref before production credentials
 * are exposed. This module is the pure decision logic for that guard; the
 * workflows call it as an early, secret-free step, before the `production`
 * environment secrets are ever resolved.
 *
 * Prod0: what counts as an "approved" ref for a production-mutation run.
 * - `production`     → explicit reviewed branch (documented default).
 * - `refs/heads/production` → fully-qualified form of the same branch.
 * - `main`           → the reviewed integration branch when explicitly listed.
 * - `refs/heads/main`→ fully-qualified form.
 * - `refs/pull/N/merge` with a strictly numeric pull number in the allowlist.
 *
 * Everything else (feature branches, local-unversioned worktrees, tags,
 * arbitrary SHAs) is rejected BEFORE any secret-bearing step.
 *
 * This module is pure, operates on synthetic ref strings, and never touches
 * credentials, so tests exercise the guard without secrets.
 */
export const PRODUCTION_MUTATION_WORKFLOWS = Object.freeze([
  "deploy-production-migrations.yml",
  "bootstrap-production-registry.yml",
] as const);

export type ProductionMutationWorkflow =
  (typeof PRODUCTION_MUTATION_WORKFLOWS)[number];

export type ReviewedRefGuardInput = Readonly<{
  workflow: ProductionMutationWorkflow;
  ref: string;
  allowedBranches: readonly string[];
  allowedPullRequests: readonly string[];
}>;

export type ReviewedRefGuardDecision =
  | Readonly<{ ok: true; ref: string; kind: "branch" | "pull_request" }>
  | Readonly<{
      ok: false;
      code:
        | "REF_MISSING"
        | "REF_EMPTY"
        | "REF_UNSUPPORTED_FORMAT"
        | "BRANCH_NOT_APPROVED"
        | "PULL_REQUEST_NOT_APPROVED";
      workflow: ProductionMutationWorkflow;
      /** Safe, bounded summary of the rejected ref (never a credential). */
      refPreview: string | null;
    }>;

export function assertReviewedRefForMutation(
  input: ReviewedRefGuardInput,
): ReviewedRefGuardDecision {
  const rawRef = input.ref;
  if (rawRef === undefined) {
    return refusal("REF_MISSING", input, null);
  }
  const trimmed = rawRef.trim();
  if (!trimmed) {
    return refusal("REF_EMPTY", input, null);
  }
  // Bounded surface for diagnostics; anything longer is never a reviewed ref.
  const refPreview = /^[A-Za-z0-9._/:-]{1,256}$/.test(trimmed)
    ? trimmed.slice(0, 256)
    : null;
  if (refPreview === null) {
    return refusal("REF_UNSUPPORTED_FORMAT", input, null);
  }

  const branch = normalizeBranch(trimmed);
  if (branch) {
    const allowed = new Set(input.allowedBranches.map(normalizeBranch));
    if (allowed.has(branch)) {
      return Object.freeze({ ok: true, ref: trimmed, kind: "branch" });
    }
    return refusal("BRANCH_NOT_APPROVED", input, refPreview);
  }

  const pullNumber = parsePullRequestRef(trimmed);
  if (pullNumber !== null) {
    const allowed = new Set(
      input.allowedPullRequests.map((value) => String(Number(value))),
    );
    if (allowed.has(String(pullNumber))) {
      return Object.freeze({ ok: true, ref: trimmed, kind: "pull_request" });
    }
    return refusal("PULL_REQUEST_NOT_APPROVED", input, refPreview);
  }

  return refusal("REF_UNSUPPORTED_FORMAT", input, refPreview);
}

export const DEFAULT_ALLOWED_MUTATION_BRANCHES = Object.freeze([
  "production",
  "main",
] as const);

export const DEFAULT_ALLOWED_MUTATION_PULLS = Object.freeze([] as const);

function refusal(
  code: Extract<ReviewedRefGuardDecision, { ok: false }>["code"],
  input: ReviewedRefGuardInput,
  refPreview: string | null,
): ReviewedRefGuardDecision {
  return Object.freeze({ ok: false, code, workflow: input.workflow, refPreview });
}

function normalizeBranch(value: string): string | null {
  if (value.startsWith("refs/heads/")) {
    const branch = value.slice("refs/heads/".length);
    return isValidBranchName(branch) ? branch : null;
  }
  if (value.startsWith("refs/")) {
    return null;
  }
  return isValidBranchName(value) ? value : null;
}

function isValidBranchName(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value);
}

function parsePullRequestRef(value: string): number | null {
  const match = /^refs\/pull\/(\d+)\/merge$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
