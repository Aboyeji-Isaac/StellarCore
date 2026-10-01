// Policy regression checks for the manual production mutation workflows.
//
// Parses `.github/workflows/bootstrap-production-registry.yml` and
// `.github/workflows/deploy-production-migrations.yml` and fails when the
// source-authorization or credential-isolation boundary regresses:
//   - missing or non-main ref guard
//   - mutable third-party action tags instead of full commit SHAs
//   - production `secrets.DATABASE_URL` passed into `npm ci`
//   - broadened permissions beyond `contents: read`
//   - production workflows triggered by anything other than workflow_dispatch
//   - install steps that do not use the placeholder generate URL
//
// Run: npm run audit:workflow
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const WORKFLOWS = [
  "bootstrap-production-registry.yml",
  "deploy-production-migrations.yml",
] as const;

const REQUIRED_ACTIONS: Record<string, string> = {
  "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
};

const PLACEHOLDER_ENV = "PRISMA_GENERATE_DATABASE_URL";
const PLACEHOLDER_HINT = "prisma-generate-placeholder";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};

type Job = {
  steps?: Step[];
  permissions?: unknown;
  environment?: string;
};

type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, Job>;
  env?: Record<string, string>;
  concurrency?: unknown;
};

function fail(file: string, message: string): never {
  throw new Error(`workflow-policy ${file}: ${message}`);
}

function normalizeOn(on: unknown): Record<string, unknown> {
  if (on == null) return {};
  if (typeof on === "string" || Array.isArray(on)) {
    return { raw: on };
  }
  return on as Record<string, unknown>;
}

function assertDispatchOnly(file: string, wf: Workflow): void {
  const on = normalizeOn(wf.on);
  if ("pull_request" in on || "push" in on || "schedule" in on || "release" in on) {
    fail(
      file,
      `production mutation workflow must not trigger on non-dispatch events: ${JSON.stringify(Object.keys(on))}`,
    );
  }
  if (!("workflow_dispatch" in on)) {
    fail(file, "production mutation workflow must keep workflow_dispatch");
  }
}

function assertPermissions(file: string, wf: Workflow): void {
  const perms = wf.permissions as Record<string, unknown> | undefined;
  if (!perms || typeof perms !== "object") {
    fail(file, "workflow must declare top-level permissions");
  }
  const keys = Object.keys(perms);
  if (keys.length !== 1 || keys[0] !== "contents" || perms.contents !== "read") {
    fail(
      file,
      `workflow permissions must be exactly contents: read (got ${JSON.stringify(perms)})`,
    );
  }
}

function assertConcurrency(file: string, wf: Workflow): void {
  const conc = wf.concurrency as { "cancel-in-progress"?: boolean } | undefined;
  if (!conc || typeof conc !== "object") {
    fail(file, "workflow must declare a concurrency group");
  }
  if (conc["cancel-in-progress"] !== false) {
    fail(file, "production mutation workflows must not cancel in-progress runs");
  }
}

function iterSteps(wf: Workflow): Array<{ job: string; step: Step }> {
  const jobs = wf.jobs ?? {};
  const out: Array<{ job: string; step: Step }> = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      out.push({ job: jobName, step });
    }
  }
  return out;
}

function assertRefGuard(file: string, wf: Workflow): void {
  const steps = iterSteps(wf);
  const guard = steps.find((s) => (s.step.if ?? "").includes("github.ref"));
  if (!guard) {
    fail(file, "missing a step conditioned on github.ref (protected main guard)");
  }
  const ifCond = guard.step.if ?? "";
  if (!ifCond.includes("refs/heads/main")) {
    fail(file, `ref guard must target refs/heads/main (got: ${ifCond})`);
  }
  if (!/exit\s+1|fail\(/i.test(guard.step.run ?? "")) {
    fail(file, "ref guard step must fail the job for non-main refs");
  }
  const guardIndex = steps.findIndex((s) => s.step === guard.step);
  for (const { step } of steps) {
    const envText = JSON.stringify(step.env ?? {});
    if (envText.includes("secrets.DATABASE_URL")) {
      const idx = steps.findIndex((s) => s.step === step);
      if (idx < guardIndex) {
        fail(file, "a step using secrets.DATABASE_URL appears before the ref guard");
      }
    }
  }
}

function assertActionPins(file: string, wf: Workflow): void {
  for (const { step } of iterSteps(wf)) {
    const uses = step.uses;
    if (!uses) continue;
    const [action, ref] = uses.split("@");
    if (!ref) {
      fail(file, `step "${step.name ?? action}" is unpinned: ${uses}`);
    }
    const required = REQUIRED_ACTIONS[action];
    if (!required) {
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        fail(
          file,
          `step "${step.name ?? action}" must pin ${action} to a full commit SHA (got @${ref})`,
        );
      }
      continue;
    }
    if (ref !== required) {
      fail(file, `step "${step.name ?? action}" must pin ${action}@${required} (got @${ref})`);
    }
  }
}

function assertCredentialIsolation(file: string, wf: Workflow): void {
  const envText = JSON.stringify(wf.env ?? {});
  if (!envText.includes(PLACEHOLDER_ENV) || !envText.includes(PLACEHOLDER_HINT)) {
    fail(
      file,
      `workflow must define ${PLACEHOLDER_ENV} as a non-production placeholder for install/generation`,
    );
  }

  for (const { step } of iterSteps(wf)) {
    const run = step.run ?? "";
    const env = step.env ?? {};
    const isInstall = /\bnpm ci\b/.test(run) || /\bnpm install\b/.test(run);
    if (!isInstall) continue;

    const installEnv = JSON.stringify(env);
    if (installEnv.includes("secrets.DATABASE_URL")) {
      fail(file, `install step "${step.name}" must not receive secrets.DATABASE_URL`);
    }
    if (
      !installEnv.includes(`env.${PLACEHOLDER_ENV}`) &&
      !installEnv.includes(PLACEHOLDER_HINT)
    ) {
      fail(
        file,
        `install step "${step.name}" must set DATABASE_URL from the ${PLACEHOLDER_ENV} placeholder`,
      );
    }
  }
}

function assertEnvironment(file: string, wf: Workflow): void {
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    if (job.environment !== "production") {
      fail(file, `job ${jobName} must use the production environment`);
    }
  }
}

function audit(file: string): void {
  const raw = readFileSync(join(WORKFLOW_DIR, file), "utf8");
  const wf = parse(raw) as Workflow;
  assertDispatchOnly(file, wf);
  assertPermissions(file, wf);
  assertConcurrency(file, wf);
  assertRefGuard(file, wf);
  assertActionPins(file, wf);
  assertCredentialIsolation(file, wf);
  assertEnvironment(file, wf);
  console.log(`ok ${file}`);
}

for (const file of WORKFLOWS) {
  audit(file);
}
console.log(`validated ${WORKFLOWS.length} production mutation workflows`);
