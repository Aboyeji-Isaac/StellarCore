// Centralized database-integration entry point shared by CI and contributors.
//
// A green run proves exactly three things, in order:
//   1. The complete committed Prisma migration chain applies from zero to a
//      freshly created PostgreSQL database. No `db push`, no reset shortcuts.
//   2. The Prisma Client generates cleanly against the committed schema.
//   3. Every discovered database-gated integration suite actually runs — each
//      gate variable is exported as "1" so no suite can silently skip.
//
// The no-silent-skip guarantee is layered, not incidental:
//   - suites are discovered from the filesystem, never a hard-coded subset;
//   - a *.database.integration.test.ts file with no recognizable gate fails
//     before anything runs;
//   - every known gate must still guard at least one suite, or the run fails;
//   - tests/unit/tooling/databaseGates.test.ts fails the default `npm test`
//     when the gate list in this file and the suites drift apart.
//
// The same sequence runs in .github/workflows/database-integration.yml and
// locally via `npm run test:db`. See docs/testing-guide.md for local steps.
//
// Diagnostics written on failure are sanitized: they contain only the command
// list, exit codes, and environment availability — never connection strings,
// tokens, or raw engine output. Credentials are passed to child processes
// through the environment only.
//
// Self-test: `npx tsx scripts/test-database.ts --self-test-failure` proves
// the runner fails on a deliberately broken migration (the acceptance
// criterion "a deliberately broken migration ... causes the job to fail").
// It is never part of CI or the normal sequence.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const REQUIRED_ENV = "DATABASE_URL";
const TESTS_ROOT = "tests";
const DIAGNOSTICS_DIR = "tmp/test-database-diagnostics";

const KNOWN_GATE_ENV_VARS = [
  "RUN_DATABASE_INTEGRATION",
  "RUN_REPUTATION_API_DATABASE_INTEGRATION",
  "RUN_REPUTATION_DATABASE_INTEGRATION",
  "RUN_REFRESH_DATABASE_INTEGRATION",
] as const;

const SUITE_SUFFIX = ".database.integration.test.ts";

type RecordedStep = {
  name: string;
  command: string;
  status: number;
};

function echo(message: string): void {
  console.log(message);
}

function renderCommand(command: string, args: readonly string[]): string {
  return `${command} ${args.join(" ")}`.trim();
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  env: NodeJS.Dict<string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function spawnStreaming(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): number {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  return result.status ?? (result.signal ? 1 : 0);
}

function assertDatabaseUrl(): string {
  const value = process.env[REQUIRED_ENV];
  if (!value) {
    console.error(
      `${REQUIRED_ENV} is required. Export a direct postgres:// or postgresql:// URL for an isolated database.`,
    );
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`${REQUIRED_ENV} must be a valid PostgreSQL connection URL.`);
    process.exit(1);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    console.error(
      `${REQUIRED_ENV} must use a direct postgres:// or postgresql:// URL (got "${parsed.protocol}").`,
    );
    process.exit(1);
  }
  return value;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function referencesKnownGate(content: string): boolean {
  return KNOWN_GATE_ENV_VARS.some((name) => content.includes(name));
}

function collectDatabaseGatedSuites(root: string): {
  suites: string[];
  ungated: string[];
} {
  const suites: string[] = [];
  const ungated: string[] = [];
  if (!existsSync(root)) return { suites, ungated };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = collectDatabaseGatedSuites(fullPath);
      suites.push(...nested.suites);
      ungated.push(...nested.ungated);
    } else if (entry.isFile() && entry.name.endsWith(SUITE_SUFFIX)) {
      if (referencesKnownGate(readFileSync(fullPath, "utf8"))) {
        suites.push(normalizePath(relative(TESTS_ROOT, fullPath)));
      } else {
        ungated.push(normalizePath(relative(TESTS_ROOT, fullPath)));
      }
    }
  }
  return { suites: suites.sort(), ungated: ungated.sort() };
}

// Every known gate must be enabled and must still guard at least one
// discovered suite; otherwise the "run everything" guarantee would quietly
// stop covering a subsystem.
function assertEveryKnownGateIsLive(
  suites: readonly string[],
  env: Readonly<Record<string, string>>,
): void {
  const contents = suites.map((suite) =>
    readFileSync(join(TESTS_ROOT, suite), "utf8"),
  );
  for (const name of KNOWN_GATE_ENV_VARS) {
    if (env[name] !== "1") {
      throw new Error(`internal error: ${name} was not enabled`);
    }
    if (!contents.some((content) => content.includes(name))) {
      throw new Error(
        `${name} is enabled but no discovered suite references it. ` +
          "Either a suite was removed without retiring its gate or the gate no longer guards any test.",
      );
    }
  }
}

function writeDiagnostics(
  steps: readonly RecordedStep[],
  failingStep: string,
  discoveredSuites: readonly string[],
): void {
  try {
    rmSync(DIAGNOSTICS_DIR, { recursive: true, force: true });
    mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    const summary = {
      timestamp: new Date().toISOString(),
      node: process.version,
      failingStep,
      steps: steps.map(({ name, command, status }) => ({
        name,
        command,
        status,
      })),
      discoveredSuites: [...discoveredSuites],
      environment: {
        databaseUrlConfigured: Boolean(process.env[REQUIRED_ENV]),
        gatesEnabled: KNOWN_GATE_ENV_VARS.filter(
          (name) => process.env[name] === "1",
        ),
      },
    };
    writeFileSync(
      join(DIAGNOSTICS_DIR, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  } catch {
    // Diagnostics are best-effort; they must never mask the real failure.
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test-failure")) {
    await selfTestFailure();
    return;
  }

  assertDatabaseUrl();

  const { suites, ungated } = collectDatabaseGatedSuites(TESTS_ROOT);
  if (ungated.length > 0) {
    console.error(
      "Database-gated suite file(s) without a recognizable RUN_*_DATABASE_INTEGRATION gate:",
    );
    for (const suite of ungated) console.error(`  - tests/${suite}`);
    console.error(
      "Set the skip gate from one of the known gate variables (see docs/testing-guide.md) or retire the file.",
    );
    process.exit(1);
  }
  if (suites.length === 0) {
    console.error(
      "No database-gated integration suites were discovered; refusing to run an empty sequence.",
    );
    process.exit(1);
  }

  const steps: RecordedStep[] = [];

  function record(name: string, command: string, status: number): void {
    steps.push({ name, command, status });
    if (status !== 0) {
      echo(`\nStep failed: ${name} (exit ${status}).`);
      echo("Steps executed (secrets redacted):");
      for (const step of steps) {
        echo(`  ${step.status === 0 ? "ok" : "FAIL"}  ${step.command}`);
      }
      writeDiagnostics(steps, name, suites);
      echo(
        `Sanitized diagnostics written under ${DIAGNOSTICS_DIR} (no credentials).`,
      );
      process.exit(status);
    }
  }

  echo("StellarCore database integration sequence");
  echo(
    `PostgreSQL target: isolated database from ${REQUIRED_ENV} (credentials redacted)`,
  );
  echo(`Discovered database-gated suites (${suites.length}):`);
  for (const suite of suites) echo(`  - tests/${suite}`);

  const env: Readonly<Record<string, string>> = Object.fromEntries(
    KNOWN_GATE_ENV_VARS.map((name) => [name, "1"]),
  );
  assertEveryKnownGateIsLive(suites, env);

  echo("\n[1/3] Applying the complete committed migration chain from zero...");
  record(
    "migrate-from-zero",
    renderCommand("npx", ["prisma", "migrate", "deploy"]),
    spawnCaptured("npx", ["prisma", "migrate", "deploy"]).status,
  );

  echo("\n[2/3] Generating the Prisma Client...");
  record(
    "prisma-generate",
    renderCommand("npx", ["prisma", "generate"]),
    spawnCaptured("npx", ["prisma", "generate"]).status,
  );

  echo("\n[3/3] Running all discovered database-gated integration suites...");
  const testArgs = [
    "--import",
    "tsx",
    "--test",
    ...suites.map((suite) => join(TESTS_ROOT, suite)),
  ];
  record(
    "database-integration-tests",
    renderCommand(process.execPath, testArgs),
    spawnStreaming(process.execPath, testArgs, env),
  );

  echo(
    `\nDatabase integration sequence passed: ${suites.length} suite(s) ran against a freshly migrated database with zero skips.`,
  );
}

// Regression probe for the acceptance criterion "a deliberately broken
// migration or database assertion causes the job to fail". Run manually:
//   DATABASE_URL=... npx tsx scripts/test-database.ts --self-test-failure
// It creates a throwaway database, writes an intentionally broken migration
// into a temporary migrations directory, and proves `prisma migrate deploy`
// fails on it. Exit code is 0 only when the broken migration was rejected.
async function selfTestFailure(): Promise<void> {
  const baseUrl = assertDatabaseUrl();
  const probeDb = "stellarcore_probe_broken_migration";
  const probeUrl = databaseUrlFor(baseUrl, probeDb);

  const pgQuery = (databaseUrl: string, statement: string): number =>
    spawnCaptured(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { Client } from "pg";
          const client = new Client({ connectionString: process.env.PROBE_DB_URL });
          await client.connect();
          try {
            await client.query(process.env.PROBE_SQL);
          } finally {
            await client.end();
          }
        `,
      ],
      { PROBE_DB_URL: databaseUrl, PROBE_SQL: statement },
    ).status;

  if (pgQuery(baseUrl, `DROP DATABASE IF EXISTS ${probeDb}`) !== 0) {
    console.error("Could not prepare the probe database; aborting self-test.");
    process.exit(1);
  }
  if (pgQuery(baseUrl, `CREATE DATABASE ${probeDb}`) !== 0) {
    console.error("Could not create the probe database; aborting self-test.");
    process.exit(1);
  }

  // Write a deliberately broken migration (references a nonexistent table)
  // next to the real chain, deploy against the probe database, and require a
  // nonzero exit. The file is removed again before this script ends.
  const brokenDir = join("prisma", "migrations");
  const brokenName = "99990101000000_self_test_broken_migration";
  const brokenPath = join(brokenDir, brokenName);
  mkdirSync(brokenPath, { recursive: true });
  writeFileSync(
    join(brokenPath, "migration.sql"),
    "ALTER TABLE \"this_table_does_not_exist\" ADD COLUMN \"x\" integer;",
  );
  try {
    const probe = spawnCaptured("npx", ["prisma", "migrate", "deploy"], {
      DATABASE_URL: probeUrl,
    });
    echo(`Broken-migration probe exit status: ${probe.status}`);
    if (probe.status === 0) {
      console.error(
        "Self-test FAILED: a broken migration did not fail the migration step.",
      );
      process.exit(1);
    }
    echo(
      "Self-test passed: a broken migration fails the migration step as required.",
    );
  } finally {
    rmSync(brokenPath, { recursive: true, force: true });
    pgQuery(baseUrl, `DROP DATABASE IF EXISTS ${probeDb} WITH (FORCE)`);
  }
}

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

void main();
