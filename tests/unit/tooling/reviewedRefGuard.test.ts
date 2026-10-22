import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ALLOWED_MUTATION_BRANCHES,
  assertReviewedRefForMutation,
  PRODUCTION_MUTATION_WORKFLOWS,
  type ReviewedRefGuardInput,
} from "@/lib/tooling/reviewedRefGuard";

const ALLOWED_PULLS = ["4711"];

function guard(
  overrides: Partial<ReviewedRefGuardInput> = {},
) {
  return assertReviewedRefForMutation({
    workflow: "deploy-production-migrations.yml",
    ref: "refs/heads/production",
    allowedBranches: DEFAULT_ALLOWED_MUTATION_BRANCHES,
    allowedPullRequests: ALLOWED_PULLS,
    ...overrides,
  });
}

test("approved refs pass the guard for both production mutation workflows", () => {
  for (const workflow of PRODUCTION_MUTATION_WORKFLOWS) {
    assert.deepEqual(guard({ workflow, ref: "production" }), {
      ok: true,
      ref: "production",
      kind: "branch",
    });
    assert.deepEqual(guard({ workflow, ref: "refs/heads/production" }), {
      ok: true,
      ref: "refs/heads/production",
      kind: "branch",
    });
  }
});

test("an approved pull-request merge ref passes, and others are rejected by number", () => {
  assert.deepEqual(guard({ ref: "refs/pull/4711/merge" }), {
    ok: true,
    ref: "refs/pull/4711/merge",
    kind: "pull_request",
  });
  assert.deepEqual(guard({ ref: "refs/pull/9999/merge" }), {
    ok: false,
    code: "PULL_REQUEST_NOT_APPROVED",
    workflow: "deploy-production-migrations.yml",
    refPreview: "refs/pull/9999/merge",
  });
});

test("unapproved feature branches fail before any secret-bearing step", () => {
  for (const ref of [
    "feature/rate-provenance",
    "refs/heads/feature/rate-provenance",
    "fix-merge-conflict",
    "staging",
  ]) {
    assert.deepEqual(guard({ ref }), {
      ok: false,
      code: "BRANCH_NOT_APPROVED",
      workflow: "deploy-production-migrations.yml",
      refPreview: ref.slice(0, 256),
    });
  }
});

test("workflow-insensitive failures: missing, blank, and malformed refs", () => {
  assert.deepEqual(guard({ ref: "" }), {
    ok: false,
    code: "REF_EMPTY",
    workflow: "deploy-production-migrations.yml",
    refPreview: null,
  });

  // A ref with control characters is unsupported format, not a wildcard.
  const malicious = "refs/heads/main\nDATABASE_URL=postgres://user:pass@host/db";
  assert.deepEqual(guard({ ref: malicious }), {
    ok: false,
    code: "REF_UNSUPPORTED_FORMAT",
    workflow: "deploy-production-migrations.yml",
    refPreview: null,
  });

  assert.deepEqual(guard({ ref: "deadbeef".repeat(40) }), {
    ok: false,
    code: "REF_UNSUPPORTED_FORMAT",
    workflow: "deploy-production-migrations.yml",
    refPreview: null,
  });
});

test("both production mutation workflows are covered by the guard contract", () => {
  assert.deepEqual(
    PRODUCTION_MUTATION_WORKFLOWS,
    ["deploy-production-migrations.yml", "bootstrap-production-registry.yml"],
  );
});

test("guard diagnostics never surface credentials embedded in refs", () => {
  const leaked =
    "refs/heads/main; export DATABASE_URL=postgresql://user:hunter2@prod:5432/db";
  const decision = guard({ ref: leaked });
  assert.equal(decision.ok, false);
  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("prod:5432"), false);
  assert.equal(serialized.includes("postgresql://"), false);
});

test("allowed pull allowlist is explicit and default is empty", () => {
  assert.deepEqual(guard({ allowedPullRequests: [], ref: "refs/pull/4711/merge" }), {
    ok: false,
    code: "PULL_REQUEST_NOT_APPROVED",
    workflow: "deploy-production-migrations.yml",
    refPreview: "refs/pull/4711/merge",
  });
});
