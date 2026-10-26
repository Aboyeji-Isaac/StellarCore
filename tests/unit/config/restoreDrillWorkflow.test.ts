import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const WORKFLOW_PATH = resolve(
  process.cwd(),
  ".github/workflows/restore-drill.yml",
);
const PREFLIGHT_SCRIPT_PATH = resolve(
  process.cwd(),
  "scripts/preflight-restore-drill.ts",
);

const RESTORE_DRILL_WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

test("restore drill workflow enforces least privilege and safe concurrency", () => {
  assert.ok(
    RESTORE_DRILL_WORKFLOW.includes("contents: read"),
    "Workflow must enforce read-only contents permission",
  );
  assert.ok(
    RESTORE_DRILL_WORKFLOW.includes("cancel-in-progress: false"),
    "Workflow must preserve non-cancelling concurrency",
  );
});

test("restore drill workflow NEVER binds to GitHub production environment or secrets", () => {
  // Production environment binding or secrets.DATABASE_URL would expose production
  // credentials to restore drill runners.
  assert.equal(
    /environment:\s*production/i.test(RESTORE_DRILL_WORKFLOW),
    false,
    "Restore drill workflow must NEVER bind to the GitHub production environment",
  );
  assert.equal(
    RESTORE_DRILL_WORKFLOW.includes("secrets.DATABASE_URL"),
    false,
    "Restore drill workflow must NEVER receive secrets.DATABASE_URL",
  );
});

test("restore drill workflow runs preflight target identity guard BEFORE restore commands", () => {
  const preflightStep = "Verify restore drill target identity is isolated";
  const restoreStep = "Restore, verify, and clean up ephemeral PostgreSQL databases";

  const preflightIndex = RESTORE_DRILL_WORKFLOW.indexOf(`- name: ${preflightStep}`);
  const restoreIndex = RESTORE_DRILL_WORKFLOW.indexOf(`- name: ${restoreStep}`);

  assert.ok(preflightIndex >= 0, `Workflow must contain step: ${preflightStep}`);
  assert.ok(restoreIndex >= 0, `Workflow must contain step: ${restoreStep}`);
  assert.ok(
    preflightIndex < restoreIndex,
    "Preflight target identity guard must run BEFORE restore execution",
  );

  // Restore step must be gated on preflight success
  assert.ok(
    RESTORE_DRILL_WORKFLOW.includes("if: ${{ success() }}"),
    "Restore step must be gated on ${{ success() }}",
  );
});

test("restore drill workflow does not contain secret-leaking commands", () => {
  const forbiddenCommands = [
    "printenv",
    "env |",
    "set -x",
    "echo $DATABASE_URL",
    "::add-mask",
    "::set-output",
  ];

  for (const forbidden of forbiddenCommands) {
    assert.equal(
      RESTORE_DRILL_WORKFLOW.includes(forbidden),
      false,
      `Workflow must not contain command: ${forbidden}`,
    );
  }
});

test("workflow validation: production target identity is refused before execution", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", PREFLIGHT_SCRIPT_PATH],
    {
      env: {
        ...process.env,
        STELLARCORE_RESTORE_TARGET_ENVIRONMENT: "production",
      },
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    1,
    "Preflight must exit with non-zero status code when target is production",
  );
  const output = result.stderr + result.stdout;
  assert.match(output, /TARGET_IDENTITY_PRODUCTION/);
  assert.match(output, /prohibited from targeting production/i);
});

test("workflow validation: approved isolated test target is accepted", () => {
  for (const testTarget of ["isolated-drill", "test", "ci", "restore-drill"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", PREFLIGHT_SCRIPT_PATH],
      {
        env: {
          ...process.env,
          STELLARCORE_RESTORE_TARGET_ENVIRONMENT: testTarget,
        },
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      `Preflight must exit with code 0 for approved target: ${testTarget}`,
    );
    assert.match(result.stdout, /TARGET_IDENTITY_APPROVED/);
  }
});

test("workflow validation: missing target identity is refused (fail-closed)", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", PREFLIGHT_SCRIPT_PATH],
    {
      env: {
        ...process.env,
        STELLARCORE_RESTORE_TARGET_ENVIRONMENT: "",
        RESTORE_TARGET_ENVIRONMENT: "",
      },
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    1,
    "Preflight must exit with non-zero status code when target identity is missing",
  );
  const output = result.stderr + result.stdout;
  assert.match(output, /TARGET_IDENTITY_MISSING/);
});

test("workflow validation: failure output never leaks credentials or connection URLs", () => {
  const secretCred = "secret_db_pass_xyz9876";
  const rawUrl = `postgresql://operator:${secretCred}@prod.cluster.internal:5432/stellarcore`;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", PREFLIGHT_SCRIPT_PATH],
    {
      env: {
        ...process.env,
        STELLARCORE_RESTORE_TARGET_ENVIRONMENT: "production",
        RESTORE_TARGET_DATABASE_URL: rawUrl,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  const fullOutput = result.stderr + result.stdout;

  assert.equal(
    fullOutput.includes(secretCred),
    false,
    "Failure output must never leak the secret credential",
  );
  assert.equal(
    fullOutput.includes(rawUrl),
    false,
    "Failure output must never leak the full raw connection URL",
  );
  assert.equal(
    /:\w+@/.test(fullOutput),
    false,
    "Failure output must not contain URL credentials pattern",
  );
});

test("workflow validation: test does not require production secrets", () => {
  assert.equal(
    Boolean(process.env.DATABASE_URL?.includes("production")),
    false,
    "Test run does not require or use production database URL",
  );
});
