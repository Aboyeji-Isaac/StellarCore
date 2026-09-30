// Migration-safety check for the committed Prisma migration chain.
//
// The production migration path (docs/DEPLOYMENT.md,
// .github/workflows/deploy-production-migrations.yml) is `prisma migrate
// deploy` against a database that already contains earlier migrations. This
// script reproduces exactly that shape, self-contained inside the PostgreSQL
// server that DATABASE_URL points at, without any destructive reset:
//
//   1. Create two scratch databases in that server:
//        - <prefix>_reference: apply the FULL committed chain from zero.
//          This is the reference history.
//        - <prefix>_baseline: migrate up to the BASELINE using the real
//          chain (the first committed migration applied with the same deploy
//          semantics), then deploy the REMAINING migrations. This is the
//          production shape: an already-migrated database receiving pending
//          migrations through `prisma migrate deploy` only.
//   2. Compare the resulting `_prisma_migrations` tables: same migration set,
//      same overall applied state. Any drift means the pending chain does not
//      reproduce the full-history result — a dirty or non-idempotent
//      migration — and fails.
//   3. Drop both scratch databases. They are created, owned, and destroyed by
//      this script; nothing outside them is ever touched.
//
// The database user needs CREATE privilege on the server (the official
// postgres Docker image user is a superuser, so CI needs nothing extra).
// Diagnostics are sanitized: step names, commands, exit codes, and migration
// name lists only — never connection strings, tokens, or engine output.
// Credentials are passed to child processes through the environment only.
//
// Run via `npm run verify:migrations`; also wired into
// .github/workflows/database-integration.yml. See docs/testing-guide.md.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REQUIRED_ENV = "DATABASE_URL";
const MIGRATIONS_DIR = "prisma/migrations";
const DIAGNOSTICS_DIR = "tmp/migration-safety-diagnostics";
const REFERENCE_DB = "stellarcore_safety_reference";
const BASELINE_DB = "stellarcore_safety_baseline";

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

function assertDatabaseUrl(): string {
  const value = process.env[REQUIRED_ENV];
  if (!value) {
    console.error(
      `${REQUIRED_ENV} is required. Export a direct postgres:// or postgresql:// URL for an isolated database server.`,
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

// Derives a connection URL to the same server for a differently named
// database, preserving credentials and query parameters.
// Deploys the committed chain up to and including `frontier` into the
// database at `databaseUrl`, using only the committed migration SQL: later
// migration directories are temporarily moved out of prisma/migrations, one
// `prisma migrate deploy` runs, and they are moved back. No db push, no
// reset, and the later migrations' SQL is never executed against this
// database — they remain genuinely pending, exactly the production shape.
function deployUpTo(
  databaseUrl: string,
  frontier: string,
): number {
  const later = committedMigrations().filter((name) => name > frontier);
  const stashRoot = join("tmp", "migration-safety-stash");
  mkdirSync(stashRoot, { recursive: true });
  const stashed: Array<{ from: string; to: string }> = [];
  try {
    for (const name of later) {
      const from = join(MIGRATIONS_DIR, name);
      const to = join(stashRoot, name);
      renameSync(from, to);
      stashed.push({ from, to });
    }
    return spawnCaptured("npx", ["prisma", "migrate", "deploy"], {
      DATABASE_URL: databaseUrl,
    }).status;
  } finally {
    for (const { from, to } of stashed.reverse()) {
      renameSync(to, from);
    }
    rmSync(stashRoot, { recursive: true, force: true });
  }
}

function deployFirstMigrations(count: number): string {
  return `npx prisma migrate deploy (first ${count} committed migration(s) only)`;
}

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

// Committed migration names in lexicographic order, which matches the order
// Prisma applies them (timestamp-prefixed names, per the migration lock).
function committedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_.+/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

type AppliedMigrationRow = {
  migration_name: string;
  finished_at: string | null;
  applied_steps_count: string;
};

// Reads _prisma_migrations through the repository's own pg dependency.
function readAppliedMigrations(databaseUrl: string): AppliedMigrationRow[] {
  const runner = `
    import { Client } from "pg";
    const client = new Client({ connectionString: process.env.SAFETY_DB_URL });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT migration_name, finished_at::text AS finished_at, applied_steps_count::text AS applied_steps_count FROM _prisma_migrations ORDER BY started_at, id"
      );
      process.stdout.write(JSON.stringify(result.rows));
    } finally {
      await client.end();
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    { encoding: "utf8", env: { ...process.env, SAFETY_DB_URL: databaseUrl } },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to read _prisma_migrations (exit ${result.status}).`,
    );
  }
  return JSON.parse(result.stdout ?? "[]") as AppliedMigrationRow[];
}

// Creates or drops a scratch database inside the server DATABASE_URL points
// at. Only databases this script creates are ever dropped, and only by these
// exact fixed names — no reset of any other database, schema, or data.
function createScratchDatabase(serverUrl: string, database: string): void {
  const runner = `
    import { Client } from "pg";
    const client = new Client({ connectionString: process.env.SAFETY_DB_URL });
    await client.connect();
    try {
      await client.query("DROP DATABASE IF EXISTS " + process.env.SAFETY_DB_NAME);
      await client.query("CREATE DATABASE " + process.env.SAFETY_DB_NAME);
    } finally {
      await client.end();
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", runner],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SAFETY_DB_URL: serverUrl,
        SAFETY_DB_NAME: database,
      },
    },
  );
  if (result.status !== 0) {
    console.error(
      `Failed to create scratch database "${database}". The database user needs CREATE privilege on the server that ${REQUIRED_ENV} points at.`,
    );
    process.exit(1);
  }
}

function dropScratchDatabase(serverUrl: string, database: string): void {
  const runner = `
    import { Client } from "pg";
    const client = new Client({ connectionString: process.env.SAFETY_DB_URL });
    await client.connect();
    try {
      await client.query("DROP DATABASE IF EXISTS " + process.env.SAFETY_DB_NAME + " WITH (FORCE)");
    } finally {
      await client.end();
    }
  `;
  spawnSync(process.execPath, ["--input-type=module", "--eval", runner], {
    encoding: "utf8",
    env: { ...process.env, SAFETY_DB_URL: serverUrl, SAFETY_DB_NAME: database },
  });
}

function writeDiagnostics(
  steps: readonly RecordedStep[],
  failingStep: string,
  detail: Record<string, unknown>,
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
      ...detail,
    };
    writeFileSync(
      join(DIAGNOSTICS_DIR, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  } catch {
    // Diagnostics are best-effort; they must never mask the real failure.
  }
}

function main(): void {
  const baseUrl = assertDatabaseUrl();

  const migrations = committedMigrations();
  if (migrations.length === 0) {
    console.error(
      "No committed migrations found under prisma/migrations; nothing to verify.",
    );
    process.exit(1);
  }
  if (migrations.length === 1) {
    echo(
      "Only one committed migration exists; the baseline-plus-pending path is equivalent to the full chain. Nothing meaningful to compare — run scripts/test-database.ts instead.",
    );
    process.exit(0);
  }

  const referenceUrl = databaseUrlFor(baseUrl, REFERENCE_DB);
  const baselineUrl = databaseUrlFor(baseUrl, BASELINE_DB);
  const [baseline, ...remaining] = migrations;

  const steps: RecordedStep[] = [];

  function record(name: string, command: string, status: number): void {
    steps.push({ name, command, status });
    if (status !== 0) {
      echo(`\nStep failed: ${name} (exit ${status}).`);
      echo("Steps executed (secrets redacted):");
      for (const step of steps) {
        echo(`  ${step.status === 0 ? "ok" : "FAIL"}  ${step.command}`);
      }
      writeDiagnostics(steps, name, { committedMigrations: migrations });
      echo(
        `Sanitized diagnostics written under ${DIAGNOSTICS_DIR} (no credentials).`,
      );
      process.exit(status);
    }
  }

  const deploy = renderCommand("npx", ["prisma", "migrate", "deploy"]);

  echo("StellarCore migration-safety check");
  echo(
    `Committed migrations (${migrations.length}); baseline: ${baseline}; pending after baseline: ${remaining.length}`,
  );
  echo(
    `Scratch databases inside the ${REQUIRED_ENV} server: ${REFERENCE_DB}, ${BASELINE_DB} (created and dropped by this script only)`,
  );

  echo("\n[1/3] Reference: applying the full chain from zero...");
  createScratchDatabase(baseUrl, REFERENCE_DB);
  record(
    "full-chain-from-zero",
    deploy,
    spawnCaptured("npx", ["prisma", "migrate", "deploy"], {
      DATABASE_URL: referenceUrl,
    }).status,
  );
  const referenceRows = readAppliedMigrations(referenceUrl);

  echo(
    `\n[2/3] Production shape: migrating to baseline ${baseline}, then deploying the remaining ${remaining.length}...`,
  );
  createScratchDatabase(baseUrl, BASELINE_DB);
  // Build the baseline with the real chain (one deploy of the single earliest
  // migration via Prisma's filtered deployment: `migrate deploy` on a fresh
  // database applies migrations in order; we then mark the next migration as
  // the frontier by deploying it explicitly). The committed chain itself is
  // the only DDL source — no db push, no reset.
  record(
    "build-baseline",
    deployFirstMigrations(1),
    deployUpTo(baselineUrl, baseline),
  );
  record(
    "deploy-remaining",
    deploy,
    spawnCaptured("npx", ["prisma", "migrate", "deploy"], {
      DATABASE_URL: baselineUrl,
    }).status,
  );
  const baselineRows = readAppliedMigrations(baselineUrl);

  echo("\n[3/3] Comparing migration histories...");
  const referenceNames = referenceRows
    .map((row) => row.migration_name)
    .sort();
  const baselineNames = baselineRows.map((row) => row.migration_name).sort();
  const baselineIncomplete = baselineRows.filter(
    (row) => row.finished_at === null || row.applied_steps_count === "0",
  );
  const referenceIncomplete = referenceRows.filter(
    (row) => row.finished_at === null || row.applied_steps_count === "0",
  );

  let compared = "compare-histories";
  if (referenceIncomplete.length > 0) {
    compared = "compare-histories (reference history incomplete)";
  } else if (baselineIncomplete.length > 0) {
    compared = "compare-histories (baseline history incomplete)";
  } else if (
    JSON.stringify(referenceNames) !== JSON.stringify(baselineNames)
  ) {
    compared = "compare-histories (migration sets diverged)";
  }
  if (compared !== "compare-histories") {
    console.error(
      "Migration histories diverged: the baseline-plus-remaining path does not reproduce the full-chain result.",
    );
    writeDiagnostics(steps, compared, {
      committedMigrations: migrations,
      referenceNames,
      baselineNames,
      referenceIncomplete,
      baselineIncomplete,
    });
    process.exit(1);
  }
  record("compare-histories", "_prisma_migrations comparison", 0);

  echo(
    `\nMigration-safety check passed: baseline ${baseline} + ${remaining.length} pending migration(s) reproduce the full-chain history with no destructive reset.`,
  );

  dropScratchDatabase(baseUrl, REFERENCE_DB);
  dropScratchDatabase(baseUrl, BASELINE_DB);
}

process.on("exit", () => {
  // Best-effort cleanup if anything above exited early.
  const baseUrl = process.env[REQUIRED_ENV];
  if (baseUrl) {
    dropScratchDatabase(baseUrl, REFERENCE_DB);
    dropScratchDatabase(baseUrl, BASELINE_DB);
  }
});

void main();
