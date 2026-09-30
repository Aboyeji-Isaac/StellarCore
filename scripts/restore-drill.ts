import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool, type PoolClient } from "pg";

const RTO_SECONDS = 15 * 60;
const RPO_SECONDS = 24 * 60 * 60;
const TABLES = [
  { name: "anchors", orderBy: "id" },
  { name: "corridors", orderBy: "id" },
  { name: "anchor_corridors", orderBy: "anchor_id, corridor_id" },
  { name: "rate_snapshots", orderBy: "id" },
  { name: "transfer_outcomes", orderBy: "id" },
  { name: "reputation_scores", orderBy: "id" },
] as const;
const REQUIRED_FOREIGN_KEYS = [
  "anchor_corridors_anchor_id_fkey",
  "anchor_corridors_corridor_id_fkey",
  "rate_snapshots_anchor_id_fkey",
  "rate_snapshots_corridor_id_fkey",
  "transfer_outcomes_anchor_id_fkey",
  "transfer_outcomes_corridor_id_fkey",
  "reputation_scores_anchor_id_fkey",
] as const;

type CommandResult = Readonly<{ code: number; stdout: string }>;
type Container = Readonly<{
  name: string;
  network: string;
  databaseUrl: string;
  pool: Pool;
}>;
type DrillErrorCode =
  | "INVALID_INPUT"
  | "BACKUP_UNREADABLE"
  | "DOCKER_UNAVAILABLE"
  | "CONTAINER_START_FAILED"
  | "DATABASE_NOT_READY"
  | "RESTORE_FAILED"
  | "MIGRATION_STATUS_FAILED"
  | "SCHEMA_MISMATCH"
  | "INTEGRITY_FAILED"
  | "APPLICATION_READ_FAILED"
  | "RTO_EXCEEDED"
  | "RPO_EXCEEDED"
  | "CLEANUP_FAILED"
  | "DRILL_FAILED";

class DrillError extends Error {
  constructor(readonly code: DrillErrorCode) {
    super(code);
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const startMilliseconds = Date.now();
  let source: Container | undefined;
  let targetCleanupSucceeded = true;
  let sourceCleanupSucceeded = true;
  let temporaryDirectory: string | undefined;
  let backupPath: string | undefined;
  let backupCreatedAt: Date | undefined;
  let rtoSeconds = RTO_SECONDS;
  let rpoSeconds = RPO_SECONDS;
  let report: Record<string, unknown> | undefined;
  let errorCode: DrillErrorCode | undefined;

  try {
    const args = parseArguments(process.argv.slice(2));
    rtoSeconds = args.rtoSeconds;
    rpoSeconds = args.rpoSeconds;

    if (args.selfTest) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "stellarcore-restore-drill-"));
      source = await startPostgres();
      await deployMigrations(source.databaseUrl);
      await runMigrations(source.databaseUrl, "MIGRATION_STATUS_FAILED");
      await seedFixture(source.pool);
      backupPath = join(temporaryDirectory, "fixture.dump");
      await createFixtureBackup(source.name, backupPath);
      backupCreatedAt = new Date();
    } else {
      backupPath = args.backupPath;
      backupCreatedAt = args.backupCreatedAt;
    }

    let backupStats;
    try {
      backupStats = await stat(backupPath!);
    } catch {
      throw new DrillError("BACKUP_UNREADABLE");
    }
    if (!backupStats.isFile() || backupStats.size === 0) {
      throw new DrillError("BACKUP_UNREADABLE");
    }
    if (backupCreatedAt!.getTime() > Date.now()) {
      throw new DrillError("INVALID_INPUT");
    }

    const backupSha256 = await hashFile(backupPath!);
    const restored = await restoreAndVerify(backupPath!, backupSha256);
    targetCleanupSucceeded = restored.cleanupSucceeded;
    let corruptedBackupRejected: boolean | undefined;
    if (args.selfTest) {
      const corruptedPath = join(temporaryDirectory!, "corrupted.dump");
      await writeFile(corruptedPath, "not a PostgreSQL custom-format archive", { mode: 0o600 });
      try {
        await restoreAndVerify(corruptedPath, await hashFile(corruptedPath));
        throw new DrillError("DRILL_FAILED");
      } catch (error) {
        if (!(error instanceof DrillError) || error.code !== "RESTORE_FAILED") throw error;
        corruptedBackupRejected = true;
      }
    }

    const recoveryAgeSeconds = Math.max(
      0,
      Math.floor((startedAt.getTime() - backupCreatedAt!.getTime()) / 1000),
    );
    const durationMs = Date.now() - startMilliseconds;
    const rtoMet = durationMs <= rtoSeconds * 1000;
    const rpoMet = recoveryAgeSeconds <= rpoSeconds;
    report = {
      ok: targetCleanupSucceeded && rtoMet && rpoMet,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      recoveryAgeSeconds,
      objectives: { rtoSeconds, rtoMet, rpoSeconds, rpoMet },
      backupSha256,
      restored,
      ...(corruptedBackupRejected === undefined ? {} : { corruptedBackupRejected }),
      cleanupSucceeded: targetCleanupSucceeded,
    };
    if (!targetCleanupSucceeded) errorCode = "CLEANUP_FAILED";
    else if (!rtoMet) errorCode = "RTO_EXCEEDED";
    else if (!rpoMet) errorCode = "RPO_EXCEEDED";
  } catch (error) {
    errorCode = error instanceof DrillError ? error.code : "DRILL_FAILED";
    if (errorCode === "CLEANUP_FAILED") targetCleanupSucceeded = false;
  } finally {
    if (source) sourceCleanupSucceeded = await stopPostgres(source);
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        sourceCleanupSucceeded = false;
      }
    }
  }

  if (!sourceCleanupSucceeded) errorCode = "CLEANUP_FAILED";
  if (errorCode) {
    process.stdout.write(`${JSON.stringify({
      ...(report ?? {}),
      ok: false,
      code: errorCode,
      cleanupSucceeded: targetCleanupSucceeded && sourceCleanupSucceeded,
      durationMs: Date.now() - startMilliseconds,
    })}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function parseArguments(args: readonly string[]): {
  selfTest: boolean;
  backupPath?: string;
  backupCreatedAt?: Date;
  rtoSeconds: number;
  rpoSeconds: number;
} {
  let selfTest = false;
  let backupPath: string | undefined;
  let backupCreatedAt: Date | undefined;
  let rtoSeconds = RTO_SECONDS;
  let rpoSeconds = RPO_SECONDS;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--self-test") {
      selfTest = true;
    } else if (flag === "--backup" && value) {
      backupPath = value;
      index += 1;
    } else if (flag === "--backup-created-at" && value) {
      backupCreatedAt = new Date(value);
      index += 1;
    } else if (flag === "--rto-seconds" && value) {
      rtoSeconds = parsePositiveSeconds(value);
      index += 1;
    } else if (flag === "--rpo-seconds" && value) {
      rpoSeconds = parsePositiveSeconds(value);
      index += 1;
    } else {
      throw new DrillError("INVALID_INPUT");
    }
  }

  if (selfTest && (backupPath || backupCreatedAt)) {
    throw new DrillError("INVALID_INPUT");
  }
  if (!selfTest && (!backupPath || !backupCreatedAt
    || !Number.isFinite(backupCreatedAt.getTime()))) {
    throw new DrillError("INVALID_INPUT");
  }

  return { selfTest, backupPath, backupCreatedAt, rtoSeconds, rpoSeconds };
}

function parsePositiveSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DrillError("INVALID_INPUT");
  }
  return parsed;
}

async function restoreAndVerify(
  backupPath: string,
  backupSha256: string,
): Promise<Record<string, unknown> & { cleanupSucceeded: boolean }> {
  let target: Container | undefined;
  let cleanupSucceeded = true;
  let result: Record<string, unknown> | undefined;
  let failure: DrillError | undefined;

  try {
    target = await startPostgres();
    const archive = createReadStream(backupPath);
    const restore = await run("docker", [
      "exec", "-i", target.name, "pg_restore", "--exit-on-error",
      "--no-owner", "--no-privileges", "-U", "postgres", "-d", "postgres",
    ], { input: archive });
    if (restore.code !== 0) throw new DrillError("RESTORE_FAILED");

    await runMigrations(target.databaseUrl, "MIGRATION_STATUS_FAILED");
    const drift = await run("npx", [
      "prisma", "migrate", "diff", "--exit-code", "--from-schema",
      "prisma/schema.prisma", "--to-config-datasource",
    ], { env: { ...process.env, DATABASE_URL: target.databaseUrl } });
    if (drift.code === 2) throw new DrillError("SCHEMA_MISMATCH");
    if (drift.code !== 0) throw new DrillError("MIGRATION_STATUS_FAILED");

    const integrity = await verifyIntegrity(target.pool);
    const reads = await verifyApplicationReads(target.databaseUrl);
    result = {
      backupSha256,
      migrationCount: integrity.migrationCount,
      schemaCompatible: true,
      tableEvidence: integrity.tableEvidence,
      relationshipsValid: true,
      reads,
    };
  } catch (error) {
    failure = error instanceof DrillError ? error : new DrillError("DRILL_FAILED");
  } finally {
    if (target) cleanupSucceeded = await stopPostgres(target);
  }

  if (!cleanupSucceeded) throw new DrillError("CLEANUP_FAILED");
  if (failure) throw failure;
  return { ...result, cleanupSucceeded };
}

async function startPostgres(): Promise<Container> {
  const suffix = randomBytes(8).toString("hex");
  const name = `stellarcore-restore-drill-${suffix}`;
  const network = `${name}-net`;
  const password = randomBytes(24).toString("hex");
  let networkCreated = false;
  let containerCreated = false;
  let pool: Pool | undefined;

  try {
    const networkResult = await run("docker", ["network", "create", network]);
    if (networkResult.code !== 0) throw new DrillError("DOCKER_UNAVAILABLE");
    networkCreated = true;

    const containerResult = await run("docker", [
      "run", "--detach", "--name", name, "--network", network,
      "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_DB=postgres",
      "--env", `POSTGRES_PASSWORD=${password}`,
      "postgres:16-alpine",
    ]);
    if (containerResult.code !== 0) throw new DrillError("CONTAINER_START_FAILED");
    containerCreated = true;

    const portResult = await run("docker", ["port", name, "5432/tcp"]);
    const portMatch = portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (portResult.code !== 0 || !portMatch) {
      throw new DrillError("CONTAINER_START_FAILED");
    }
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${portMatch[1]}/postgres`;
    pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 1500 });
    await waitForDatabase(pool);
    return { name, network, databaseUrl, pool };
  } catch (error) {
    if (pool) await pool.end().catch(() => undefined);
    let cleanupSucceeded = true;
    if (containerCreated) {
      cleanupSucceeded = (await run("docker", ["rm", "--force", name])).code === 0
        && cleanupSucceeded;
    }
    if (networkCreated) {
      cleanupSucceeded = (await run("docker", ["network", "rm", network])).code === 0
        && cleanupSucceeded;
    }
    if (!cleanupSucceeded) throw new DrillError("CLEANUP_FAILED");
    if (error instanceof DrillError) throw error;
    throw new DrillError("CONTAINER_START_FAILED");
  }
}

async function waitForDatabase(pool: Pool): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new DrillError("DATABASE_NOT_READY");
}

async function stopPostgres(container: Container): Promise<boolean> {
  let succeeded = true;
  try {
    await container.pool.end();
  } catch {
    succeeded = false;
  }
  const removeContainer = await run("docker", ["rm", "--force", container.name]);
  const removeNetwork = await run("docker", ["network", "rm", container.network]);
  return succeeded && removeContainer.code === 0 && removeNetwork.code === 0;
}

async function runMigrations(databaseUrl: string, failureCode: DrillErrorCode): Promise<void> {
  const status = await run("npx", ["prisma", "migrate", "status"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (status.code !== 0) throw new DrillError(failureCode);
}

async function deployMigrations(databaseUrl: string): Promise<void> {
  const deploy = await run("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (deploy.code !== 0) throw new DrillError("MIGRATION_STATUS_FAILED");
}

async function verifyIntegrity(pool: Pool): Promise<{
  migrationCount: number;
  tableEvidence: Record<string, { rowCount: number; sampledRows: number; sampleSha256: string }>;
}> {
  try {
    const failedMigrations = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
    const failedCount = Number(failedMigrations.rows[0]?.count ?? "0");
    const migrations = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    const migrationCount = Number(migrations.rows[0]?.count ?? "0");
    if (failedCount > 0 || migrationCount === 0) throw new DrillError("MIGRATION_STATUS_FAILED");

    const foreignKeys = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND convalidated = true
    `);
    const foundKeys = new Set(foreignKeys.rows.map(({ conname }) => conname));
    if (REQUIRED_FOREIGN_KEYS.some((key) => !foundKeys.has(key))) {
      throw new DrillError("INTEGRITY_FAILED");
    }

    const orphanChecks = [
      `SELECT count(*) FROM anchor_corridors child LEFT JOIN anchors parent ON parent.id = child.anchor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM anchor_corridors child LEFT JOIN corridors parent ON parent.id = child.corridor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM rate_snapshots child LEFT JOIN anchors parent ON parent.id = child.anchor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM rate_snapshots child LEFT JOIN corridors parent ON parent.id = child.corridor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM transfer_outcomes child LEFT JOIN anchors parent ON parent.id = child.anchor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM transfer_outcomes child LEFT JOIN corridors parent ON parent.id = child.corridor_id WHERE parent.id IS NULL`,
      `SELECT count(*) FROM reputation_scores child LEFT JOIN anchors parent ON parent.id = child.anchor_id WHERE parent.id IS NULL`,
    ];
    for (const query of orphanChecks) {
      const result = await pool.query<{ count: string }>(query);
      if (Number(result.rows[0]?.count ?? "0") !== 0) {
        throw new DrillError("INTEGRITY_FAILED");
      }
    }

    const tableEvidence: Record<string, { rowCount: number; sampledRows: number; sampleSha256: string }> = {};
    for (const table of TABLES) {
      const count = await pool.query<{ count: string }>(`SELECT count(*) FROM "${table.name}"`);
      const sample = await pool.query(`SELECT * FROM "${table.name}" ORDER BY ${table.orderBy} LIMIT 100`);
      const sampleSha256 = createHash("sha256")
        .update(JSON.stringify(sample.rows))
        .digest("hex");
      tableEvidence[table.name] = {
        rowCount: Number(count.rows[0]?.count ?? "0"),
        sampledRows: sample.rowCount ?? 0,
        sampleSha256,
      };
    }
    if (tableEvidence.anchors.rowCount === 0
      || tableEvidence.corridors.rowCount === 0
      || tableEvidence.anchor_corridors.rowCount === 0) {
      throw new DrillError("INTEGRITY_FAILED");
    }
    return { migrationCount, tableEvidence };
  } catch (error) {
    if (error instanceof DrillError) throw error;
    throw new DrillError("INTEGRITY_FAILED");
  }
}

async function verifyApplicationReads(databaseUrl: string): Promise<Record<string, number>> {
  process.env.DATABASE_URL = databaseUrl;
  try {
    const [anchors, anchor, corridors, corridor, rates, reputation] = await Promise.all([
      import("@/lib/api/anchors").then(({ getAnchorsApiResult }) => getAnchorsApiResult()),
      import("@/lib/api/anchors").then(({ getAnchorApiResult }) => getAnchorApiResult("zeam")),
      import("@/lib/api/corridors").then(({ getCorridorsApiResult }) => getCorridorsApiResult()),
      import("@/lib/api/corridors").then(({ getCorridorApiResult }) => getCorridorApiResult("usdc-us-brl-br")),
      import("@/lib/api/rates").then(({ getRatesApiResult }) => getRatesApiResult("usdc-us-brl-br")),
      import("@/lib/api/reputation").then(({ getAnchorReputationApiResult }) => getAnchorReputationApiResult("zeam")),
    ]);
    const statuses = [anchors.status, anchor.status, corridors.status, corridor.status, rates.status, reputation.status];
    if (statuses.some((status) => status !== 200)) throw new DrillError("APPLICATION_READ_FAILED");
    if (anchors.status !== 200 || !anchors.body.anchors.some(({ slug }) => slug === "zeam")) {
      throw new DrillError("APPLICATION_READ_FAILED");
    }
    if (corridor.status !== 200 || corridor.body.corridor.slug !== "usdc-us-brl-br") {
      throw new DrillError("APPLICATION_READ_FAILED");
    }
    if (rates.status !== 200 || rates.body.observations.length === 0) {
      throw new DrillError("APPLICATION_READ_FAILED");
    }
    if (reputation.status !== 200 || !reputation.body.reputation.evidence) {
      throw new DrillError("APPLICATION_READ_FAILED");
    }
    return {
      anchorDirectory: anchors.status,
      anchorDetail: anchor.status,
      corridorDirectory: corridors.status,
      corridorDetail: corridor.status,
      rates: rates.status,
      reputation: reputation.status,
    };
  } catch (error) {
    if (error instanceof DrillError) throw error;
    throw new DrillError("APPLICATION_READ_FAILED");
  }
}

async function seedFixture(client: PoolClient | Pool): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO anchors (id, slug, name, home_domain, toml_url, seps, is_transfer_capable, status) VALUES
        ('00000000-0000-4000-8000-000000000001', 'zeam', 'Zeam', 'zeam.money', 'https://zeam.money/.well-known/stellar.toml', ARRAY[1,38], true, 'LIVE'),
        ('00000000-0000-4000-8000-000000000002', 'cowrie', 'Cowrie', 'cowrie.exchange', 'https://cowrie.exchange/.well-known/stellar.toml', ARRAY[1,6], true, 'LIVE'),
        ('00000000-0000-4000-8000-000000000003', 'moneygram', 'MoneyGram', 'mgxanchor.moneygram.com', 'https://mgxanchor.moneygram.com/.well-known/stellar.toml', ARRAY[1,24], true, 'LIVE');
      INSERT INTO corridors (id, asset_code_from, country_from, asset_code_to, country_to, slug) VALUES
        ('00000000-0000-4000-8000-000000000011', 'USDC', 'US', 'BRL', 'BR', 'usdc-us-brl-br'),
        ('00000000-0000-4000-8000-000000000012', 'NGNT', 'NG', 'NGN', 'NG', 'ngnt-ng-ngn-ng'),
        ('00000000-0000-4000-8000-000000000013', 'USDC', 'US', 'USD', 'US', 'usdc-us-usd-us');
      INSERT INTO anchor_corridors (anchor_id, corridor_id) VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011'),
        ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012'),
        ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000013');
      INSERT INTO rate_snapshots (id, anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at) VALUES
        ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 5.25, 1, 5.25, 0, now());
      INSERT INTO transfer_outcomes (id, anchor_id, corridor_id, status, fill_rate, settlement_ms, slippage, recorded_at) VALUES
        ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'COMPLETED', 1, 1500, 0.001, now());
      INSERT INTO reputation_scores (id, anchor_id, composite_score, score_band, fill_rate_7d, fill_rate_30d, fill_rate_90d, settle_p50_ms, settle_p95_ms, slippage_p50, slippage_p95, sample_size, state, computed_at) VALUES
        ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000001', 98, 'green', 1, 1, 1, 1500, 1500, 0.001, 0.001, 1, 'ok', now());
    `);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new DrillError("INTEGRITY_FAILED");
  }
}

async function createFixtureBackup(containerName: string, outputPath: string): Promise<void> {
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const outputFinished = finished(output);
  const result = await run("docker", ["exec", containerName, "pg_dump", "--format=custom", "-U", "postgres", "-d", "postgres"], { output });
  await outputFinished;
  if (result.code !== 0) throw new DrillError("BACKUP_UNREADABLE");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        env: { ...process.env, ...options.env },
        stdio: [options.input ? "pipe" : "ignore", "pipe", "ignore"],
      });
    } catch {
      reject(new DrillError(command === "docker" ? "DOCKER_UNAVAILABLE" : "DRILL_FAILED"));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.output) options.output.write(chunk);
      else if (stdout.length < 64_000) stdout += chunk.toString("utf8").slice(0, 64_000 - stdout.length);
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new DrillError(command === "docker" ? "DOCKER_UNAVAILABLE" : "DRILL_FAILED"));
      }
    });
    child.on("close", (code) => {
      options.output?.end();
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout });
      }
    });
    if (options.input) options.input.pipe(child.stdin!);
  });
}

void main();