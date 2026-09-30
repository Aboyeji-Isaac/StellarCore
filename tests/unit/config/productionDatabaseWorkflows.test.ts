import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Privileged production workflows are the mutation boundary for the production
 * database, so the target-identity guard is asserted against the workflow files
 * themselves rather than trusted to review. A later edit that reorders the
 * preflight, drops it, or un-gates the mutation step fails here.
 */

const MIGRATION_WORKFLOW = readFileSync(
  new URL("../../../.github/workflows/deploy-production-migrations.yml", import.meta.url),
  "utf8",
);
const BOOTSTRAP_WORKFLOW = readFileSync(
  new URL("../../../.github/workflows/bootstrap-production-registry.yml", import.meta.url),
  "utf8",
);

const PREFLIGHT_STEP = "Verify production database target identity";
const PREFLIGHT_COMMAND = "npm run preflight:production-database";

const WORKFLOWS = Object.freeze([
  {
    name: "deploy-production-migrations.yml",
    source: MIGRATION_WORKFLOW,
    mutationStep: "Apply migrations",
    mutationCommand: "npx prisma migrate deploy",
  },
  {
    name: "bootstrap-production-registry.yml",
    source: BOOTSTRAP_WORKFLOW,
    mutationStep: "Bootstrap registry",
    mutationCommand: "npm run bootstrap:registry",
  },
]);

for (const workflow of WORKFLOWS) {
  test(`${workflow.name} runs the read-only target identity preflight`, () => {
    assert.ok(
      workflow.source.includes(`- name: ${PREFLIGHT_STEP}`),
      `${workflow.name} is missing the ${PREFLIGHT_STEP} step`,
    );
    assert.ok(
      workflow.source.includes(`run: ${PREFLIGHT_COMMAND}`),
      `${workflow.name} does not run \`${PREFLIGHT_COMMAND}\``,
    );
  });

  test(`${workflow.name} verifies the target before it mutates`, () => {
    const preflightIndex = workflow.source.indexOf(`- name: ${PREFLIGHT_STEP}`);
    const mutationIndex = workflow.source.indexOf(`- name: ${workflow.mutationStep}`);

    assert.ok(preflightIndex >= 0, "preflight step missing");
    assert.ok(mutationIndex >= 0, `${workflow.mutationStep} step missing`);
    assert.ok(
      preflightIndex < mutationIndex,
      `${workflow.name} must verify the production database target before ${workflow.mutationStep}`,
    );
  });

  test(`${workflow.name} gates its mutation step on the preflight succeeding`, () => {
    // `if: success()` is the default, but it is written explicitly so that a
    // future edit cannot reorder, duplicate, or conditionally skip the preflight
    // and silently turn the guard back into advice.
    const step = stepAt(workflow.source, workflow.mutationStep);
    assert.match(step, /if: \$\{\{ success\(\) \}\}/);
  });

  test(`${workflow.name} still runs only its reviewed mutation command`, () => {
    assert.ok(workflow.source.includes(`run: ${workflow.mutationCommand}`));

    for (const forbidden of [
      "prisma migrate dev",
      "prisma db push",
      "migrate reset",
      "DROP DATABASE",
      "TRUNCATE",
    ]) {
      const withoutComment = workflow.source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      assert.equal(
        withoutComment.includes(forbidden),
        false,
        `${workflow.name} must never run \`${forbidden}\``,
      );
    }
  });

  test(`${workflow.name} scopes the database secret to individual steps`, () => {
    const secretUsages = workflow.source
      .split("\n")
      .filter((line) => line.includes("secrets.DATABASE_URL"));
    assert.ok(secretUsages.length >= 3, "the preflight must receive the credential");

    for (const usage of secretUsages) {
      assert.match(usage, /^\s+DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}$/);
    }

    // A workflow-level or job-level `env:` block would widen the secret's blast
    // radius to every step, including any future step that logs its environment.
    assert.equal(/^env:$/m.test(workflow.source), false);
    assert.equal(/^\s{4}env:$/m.test(workflow.source), false);
  });

  test(`${workflow.name} never prints the database secret`, () => {
    const withoutComments = workflow.source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    for (const forbidden of [
      "printenv",
      "env |",
      "set -x",
      "echo $DATABASE_URL",
      "echo ${{",
      "::add-mask",
      "::set-output",
    ]) {
      assert.equal(
        withoutComments.includes(forbidden),
        false,
        `${workflow.name} must not contain \`${forbidden}\``,
      );
    }
  });

  test(`${workflow.name} keeps least privilege and a non-cancelling lock`, () => {
    assert.ok(workflow.source.includes("contents: read"));
    assert.ok(workflow.source.includes("cancel-in-progress: false"));
    assert.ok(workflow.source.includes("environment: production"));
    assert.ok(workflow.source.includes("workflow_dispatch:"));
    assert.equal(
      /pull_request|push:|schedule:/.test(workflow.source),
      false,
      `${workflow.name} must stay manually dispatched`,
    );
  });

  test(`${workflow.name} does not inline the production target identity`, () => {
    // The identity is reviewed in the repository, not duplicated into a
    // workflow, so it cannot drift from `constants/productionDatabaseIdentity.ts`
    // and it is not a second place a secret could be pasted.
    const withoutComments = workflow.source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    assert.equal(withoutComments.includes("sha256:"), false);
    assert.equal(withoutComments.includes("PRODUCTION_DATABASE_EXPECTED_"), false);
  });
}

test("the target identity registry is a reviewed repository file, not a secret", () => {
  const registry = readFileSync(
    new URL("../../../constants/productionDatabaseIdentity.ts", import.meta.url),
    "utf8",
  );

  assert.ok(registry.includes("PRODUCTION_DATABASE_IDENTITIES"));
  assert.ok(registry.includes("clusterFingerprints"));
  // Strip comments before checking: the file explains *why* the identity is not
  // a secret, and that explanation necessarily names the things it must not
  // contain. Only the executable registry value is constrained.
  const code = registry
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  for (const forbidden of ["password", "DATABASE_URL", "postgresql://", "postgres://", ":@"]) {
    assert.equal(code.includes(forbidden), false, `registry code leaked ${forbidden}`);
  }
});

function stepAt(source: string, stepName: string): string {
  const index = source.indexOf(`- name: ${stepName}`);
  assert.ok(index >= 0, `step \`${stepName}\` not found`);
  const rest = source.slice(index + 1);
  const next = rest.indexOf("\n      - name:");
  return next === -1 ? rest : rest.slice(0, next);
}
