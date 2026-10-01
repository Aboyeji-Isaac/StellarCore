import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const BOOTSTRAP = "bootstrap-production-registry.yml";
const MIGRATE = "deploy-production-migrations.yml";

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { steps?: Step[]; permissions?: unknown; environment?: string };
type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  jobs?: Record<string, Job>;
  env?: Record<string, string>;
};

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow;
}

function stepsOf(wf: Workflow): Step[] {
  const out: Step[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    out.push(...(job.steps ?? []));
  }
  return out;
}

/** In-process policy assertions shared by committed-workflow tests and fixtures. */
function assertPolicy(file: string, wf: Workflow): void {
  const on = (wf.on ?? {}) as Record<string, unknown>;
  assert.ok("workflow_dispatch" in on, `${file} must keep workflow_dispatch`);
  assert.ok(
    !("push" in on) && !("pull_request" in on) && !("schedule" in on) && !("release" in on),
    `${file} must not fire on push/PR/schedule/release`,
  );

  const perms = wf.permissions as Record<string, unknown>;
  assert.deepEqual(perms, { contents: "read" }, `${file} permissions must be contents: read`);

  const steps = stepsOf(wf);
  const guard = steps.find((s) => (s.if ?? "").includes("github.ref"));
  assert.ok(guard, `${file} must include a github.ref guard`);
  assert.match(guard!.if ?? "", /refs\/heads\/main/);
  assert.match(guard!.run ?? "", /exit\s+1/);

  for (const step of steps) {
    if (!step.uses) continue;
    const [action, ref] = step.uses.split("@");
    assert.match(
      ref,
      /^[0-9a-f]{40}$/,
      `${file}: ${action} must be pinned to a full commit SHA (got @${ref})`,
    );
  }

  const installs = steps.filter((s) => /\bnpm ci\b/.test(s.run ?? ""));
  assert.ok(installs.length >= 1, `${file} must contain an npm ci step`);
  for (const step of installs) {
    const env = JSON.stringify(step.env ?? {});
    assert.ok(
      !env.includes("secrets.DATABASE_URL"),
      `${file}: install step must not receive secrets.DATABASE_URL`,
    );
    assert.ok(
      env.includes("env.PRISMA_GENERATE_DATABASE_URL") ||
        env.includes("prisma-generate-placeholder"),
      `${file}: install step must use the placeholder generate URL`,
    );
  }

  const secretSteps = steps.filter((s) =>
    JSON.stringify(s.env ?? {}).includes("secrets.DATABASE_URL"),
  );
  assert.ok(secretSteps.length >= 1, `${file} must scope secrets.DATABASE_URL to mutation steps`);
  const guardIndex = steps.indexOf(guard!);
  for (const step of secretSteps) {
    assert.ok(
      steps.indexOf(step) > guardIndex,
      `${file}: secret-using step "${step.name}" must run after the ref guard`,
    );
  }

  const conc = wf.concurrency as { "cancel-in-progress"?: boolean };
  assert.equal(
    conc?.["cancel-in-progress"],
    false,
    `${file} must not cancel in-progress production runs`,
  );

  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    assert.equal(
      job.environment,
      "production",
      `${file}: job ${name} must use the production environment`,
    );
  }

  const env = (wf.env ?? {}) as Record<string, string>;
  assert.ok(
    (env.PRISMA_GENERATE_DATABASE_URL ?? "").includes("prisma-generate-placeholder"),
    `${file} must define PRISMA_GENERATE_DATABASE_URL as a non-production placeholder`,
  );
}

function safeFixture(): string {
  return [
    "name: Bootstrap production registry",
    "on:",
    "  workflow_dispatch:",
    "concurrency:",
    "  group: production-registry-bootstrap",
    "  cancel-in-progress: false",
    "permissions:",
    "  contents: read",
    "env:",
    "  PRISMA_GENERATE_DATABASE_URL: postgresql://prisma-generate-placeholder.invalid:5432/placeholder",
    "jobs:",
    "  bootstrap:",
    "    environment: production",
    "    steps:",
    "      - name: Require protected main ref",
    "        if: github.ref != 'refs/heads/main'",
    "        run: |",
    '          echo "refusing non-main"',
    "          exit 1",
    "      - name: Check out repository",
    "        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "        with:",
    "          ref: ${{ github.sha }}",
    "      - name: Set up Node.js 22",
    "        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "        with:",
    "          node-version: '22'",
    "      - name: Install dependencies",
    "        run: npm ci",
    "        env:",
    "          DATABASE_URL: ${{ env.PRISMA_GENERATE_DATABASE_URL }}",
    "      - name: Bootstrap registry",
    "        run: npm run bootstrap:registry",
    "        env:",
    "          DATABASE_URL: ${{ secrets.DATABASE_URL }}",
    "",
  ].join("\n");
}

describe("production workflow policy (committed workflows)", () => {
  for (const file of [BOOTSTRAP, MIGRATE]) {
    it(`${file} is protected-main-only with immutable action pins and isolated install secrets`, () => {
      assertPolicy(file, loadWorkflow(file));
    });
  }

  it("npm run audit:workflow succeeds on the committed workflows", () => {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/audit-workflow-policy.ts"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  });
});

describe("production workflow policy (negative fixtures)", () => {
  function parseFixture(content: string): Workflow {
    return parse(content) as Workflow;
  }

  it("accepts a safe fixture", () => {
    assertPolicy("fixture.yml", parseFixture(safeFixture()));
  });

  it("rejects an unsafe ref (non-main dispatch permitted)", () => {
    const lines = safeFixture().split("\n");
    const start = lines.findIndex((l) => l.includes("Require protected main ref"));
    const end = lines.findIndex((l, i) => i > start && l.includes("Check out repository"));
    assert.ok(start >= 0 && end > start, "fixture must contain a guard step to remove");
    const bad = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
    assert.throws(
      () => assertPolicy("fixture.yml", parseFixture(bad)),
      /ref guard|github\.ref|refs\/heads\/main/i,
    );
  });

  it("rejects tag-pinned third-party actions", () => {
    const bad = safeFixture().replaceAll(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "actions/checkout@v4",
    );
    assert.throws(() => assertPolicy("fixture.yml", parseFixture(bad)), /SHA|@v4|pin/i);
  });

  it("rejects production secrets in the install step", () => {
    const bad = safeFixture().replace(
      "DATABASE_URL: ${{ env.PRISMA_GENERATE_DATABASE_URL }}",
      "DATABASE_URL: ${{ secrets.DATABASE_URL }}",
    );
    assert.throws(
      () => assertPolicy("fixture.yml", parseFixture(bad)),
      /secrets\.DATABASE_URL|install step/i,
    );
  });

  it("rejects broadened permissions", () => {
    const bad = safeFixture().replace("contents: read", "contents: write");
    assert.throws(() => assertPolicy("fixture.yml", parseFixture(bad)), /permissions/i);
  });

  it("rejects non-dispatch triggers", () => {
    const bad = safeFixture().replace(
      "on:\n  workflow_dispatch:",
      "on:\n  workflow_dispatch:\n  push:\n    branches: [main]",
    );
    assert.throws(
      () => assertPolicy("fixture.yml", parseFixture(bad)),
      /dispatch|push|trigger/i,
    );
  });

  it("rejects mutating workflows that would cancel in-progress production runs", () => {
    const bad = safeFixture().replace("cancel-in-progress: false", "cancel-in-progress: true");
    assert.throws(
      () => assertPolicy("fixture.yml", parseFixture(bad)),
      /cancel-in-progress|cancel/i,
    );
  });
});
