import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Drift guard for the database-integration path (issue #112). The CI runner
// (scripts/test-database.ts) only executes *.database.integration.test.ts
// files that gate their skip on a known RUN_*_DATABASE_INTEGRATION variable,
// and only exports the variables listed here. This test fails the default
// `npm test` run when those two lists stop matching reality, so a new suite
// can never silently skip in CI.

const KNOWN_GATE_ENV_VARS = [
  "RUN_DATABASE_INTEGRATION",
  "RUN_REPUTATION_API_DATABASE_INTEGRATION",
  "RUN_REPUTATION_DATABASE_INTEGRATION",
  "RUN_REFRESH_DATABASE_INTEGRATION",
] as const;

const SUITE_SUFFIX = ".database.integration.test.ts";

function collectSuiteFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSuiteFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(SUITE_SUFFIX)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function gateVariablesReferencedBy(content: string): string[] {
  return KNOWN_GATE_ENV_VARS.filter((name) => content.includes(name));
}

test("every database-gated suite skips from a known gate variable", () => {
  const suites = collectSuiteFiles("tests/integration");
  assert.notEqual(
    suites.length,
    0,
    "No *.database.integration.test.ts suites found; the database-integration CI path would be empty.",
  );

  const ungated = suites.filter(
    (path) => gateVariablesReferencedBy(readFileSync(path, "utf8")).length === 0,
  );
  assert.deepEqual(
    ungated,
    [],
    "These database-gated suites set their skip gate from an unknown variable; scripts/test-database.ts would not run them. Use one of the known RUN_*_DATABASE_INTEGRATION variables or extend KNOWN_GATE_ENV_VARS here and in the runner.",
  );
});

test("every known gate variable still guards at least one suite", () => {
  const contents = collectSuiteFiles("tests/integration").map((path) =>
    readFileSync(path, "utf8"),
  );
  const orphaned = KNOWN_GATE_ENV_VARS.filter(
    (name) => !contents.some((content) => content.includes(name)),
  );
  assert.deepEqual(
    orphaned,
    [],
    "These gate variables no longer guard any suite; retire them from KNOWN_GATE_ENV_VARS in tests/unit/tooling/databaseGates.test.ts and scripts/test-database.ts.",
  );
});

test("the runner exports every gate variable suites actually read", () => {
  const runnerPath = "scripts/test-database.ts";
  const runner = readFileSync(runnerPath, "utf8");
  const suites = collectSuiteFiles("tests/integration");
  const referenced = new Set(
    suites.flatMap((path) => gateVariablesReferencedBy(readFileSync(path, "utf8"))),
  );
  const missing = [...referenced].filter(
    (name) => !runner.includes(`"${name}"`),
  );
  assert.deepEqual(
    missing,
    [],
    `scripts/test-database.ts does not enable: ${missing.join(", ")}. Add it to KNOWN_GATE_ENV_VARS there so CI runs the suite.`,
  );
});

test("package.json exposes the documented database commands", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(typeof scripts["test:db"], "string");
  assert.equal(scripts["test:db"], "tsx scripts/test-database.ts");
  assert.equal(scripts["verify:migrations"], "tsx scripts/verify-migration-safety.ts");
  assert.ok(statSync("scripts/test-database.ts").isFile());
  assert.ok(statSync("scripts/verify-migration-safety.ts").isFile());
});
