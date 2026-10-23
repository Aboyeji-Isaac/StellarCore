/**
 * Reproducible benchmark for the two latest-observation reads:
 *
 *   rates       findLatestObservations   newest snapshot per anchor, one corridor
 *   reputation  readEvidence latestRates newest snapshot per corridor, one anchor
 *
 * Each is run in two forms against the same synthetic data: the DISTINCT ON
 * query that shipped before (frozen in tests/support) and the lateral top-one
 * query in production now. Every measurement is an EXPLAIN (ANALYZE, BUFFERS,
 * FORMAT JSON), so the output carries actual rows visited and buffers, not just
 * a latency.
 *
 * Safety: the data is synthetic and written to the database named by
 * BENCHMARK_DATABASE_URL, which is deliberately NOT DATABASE_URL so a real
 * connection string in .env can never be picked up by accident. The script
 * refuses to run if that database holds any anchor or corridor that is not its
 * own (slug prefix "bench-"), and removes only what it created. Point it at a
 * throwaway database, never at production.
 *
 *   BENCHMARK_DATABASE_URL=postgresql://... npm run benchmark:latest-observations \
 *     -- [--scenario <name>] [--runs 15] [--out results.json] [--plans-dir dir]
 *
 * Cold cache: set BENCHMARK_COLD_RESTART_COMMAND (for example
 * "podman restart my-postgres") and each variant is also measured once right
 * after that command, with PostgreSQL's shared buffers empty. The operating
 * system's page cache is NOT dropped (that needs root), so a cold figure here
 * means cold shared_buffers over a warm OS cache, not a cold disk.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";
import type { Prisma } from "@/app/generated/prisma/client";

import { latestObservationsQuery } from "@/lib/rates/latestRateRepository";
import { latestCorridorRatesQuery } from "@/lib/reputation/repository";
import {
  legacyLatestCorridorRatesQuery,
  legacyLatestObservationsQuery,
} from "../tests/support/legacyLatestObservationQueries";

type Scenario = Readonly<{
  name: string;
  anchors: number;
  corridors: number;
  /** Snapshots per (anchor, corridor) pair. */
  depth: number;
}>;

// Two sweeps. Depth holds the groups fixed (20 anchors x 3 corridors) and grows
// history by 100x, ending on a ~1M-row table. Groups holds depth fixed and grows
// the anchor and corridor counts, which is the part of the cost the lateral
// plan does pay for.
const SCENARIOS: readonly Scenario[] = [
  { name: "depth-100", anchors: 20, corridors: 3, depth: 100 },
  { name: "depth-1000", anchors: 20, corridors: 3, depth: 1_000 },
  { name: "depth-10000", anchors: 20, corridors: 3, depth: 10_000 },
  { name: "million-rows", anchors: 20, corridors: 3, depth: 16_667 },
  { name: "anchors-100", anchors: 100, corridors: 3, depth: 1_000 },
  { name: "anchors-500", anchors: 500, corridors: 3, depth: 1_000 },
  { name: "corridors-30", anchors: 20, corridors: 30, depth: 1_000 },
  { name: "corridors-150", anchors: 20, corridors: 150, depth: 500 },
];

const PLAN_SCENARIO = "million-rows";
const SEED_BASE = "2026-09-01T00:00:00Z";

// legacy          the DISTINCT ON query as the planner chooses to run it
// legacy-indexed  the same query with sequential scans disabled, forcing the
//                 ordered index-only scan that the #70 covering indexes were
//                 built for, so the comparison is not against a seq-scan
//                 strawman when the planner would not have used the index
// lateral         the production query, with no planner settings changed
const VARIANTS = [
  { name: "legacy", query: "legacy", setup: [] as string[] },
  { name: "legacy-indexed", query: "legacy", setup: ["SET enable_seqscan = off"] },
  { name: "lateral", query: "lateral", setup: [] as string[] },
] as const;

type Variant = "legacy" | "lateral";
type QueryName = "rates" | "reputation";
type PlanNode = {
  "Node Type": string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Heap Fetches"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};
type ExplainResult = {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
};

function parseArgs(argv: readonly string[]) {
  const args = { scenario: undefined as string | undefined, runs: 15, out: undefined as string | undefined, plansDir: undefined as string | undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--scenario") args.scenario = value;
    else if (flag === "--runs") args.runs = Number(value);
    else if (flag === "--out") args.out = value;
    else if (flag === "--plans-dir") args.plansDir = value;
    else continue;
    index += 1;
  }
  if (!Number.isInteger(args.runs) || args.runs < 3) throw new Error("--runs must be an integer >= 3");
  return args;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/**
 * Rows the scan nodes touched: rows returned by each scan times its loops, plus
 * rows a filter threw away. This is the number that grows with history when a
 * plan walks it, and stays flat when a plan probes for the newest row.
 */
function planMetrics(plan: ExplainResult) {
  let rowsVisited = 0;
  let heapFetches = 0;
  const scans = new Set<string>();
  walk(plan.Plan, (node) => {
    if (!node["Node Type"].endsWith("Scan")) return;
    const loops = node["Actual Loops"] ?? 1;
    rowsVisited += ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * loops;
    heapFetches += (node["Heap Fetches"] ?? 0) * loops;
    scans.add(node["Node Type"]);
  });
  return {
    rowsVisited,
    heapFetches,
    scanNodes: [...scans].sort(),
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: plan.Plan["Shared Read Blocks"] ?? 0,
    planningMs: round(plan["Planning Time"]),
    executionMs: round(plan["Execution Time"]),
  };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function assertSafeTarget(client: Client): Promise<void> {
  const { rows } = await client.query<{ foreign: string }>(
    `SELECT (SELECT count(*) FROM anchors WHERE slug NOT LIKE 'bench-%')
          + (SELECT count(*) FROM corridors WHERE slug NOT LIKE 'bench-%') AS foreign`,
  );
  if (Number(rows[0]?.foreign) !== 0) {
    throw new Error(
      "Refusing to run: the target database holds anchors or corridors that this benchmark did not create. Use an empty, throwaway database.",
    );
  }
}

async function clean(client: Client): Promise<void> {
  // TRUNCATE, not DELETE: DELETE plus VACUUM leaves the indexes at their old
  // size, and a bloated index inflates the planner's cost for exactly the
  // ordered index-only scan being measured, flipping the baseline to a
  // sequential scan for reasons that have nothing to do with the query. Every
  // scenario must start from freshly created index files.
  // Nothing references rate_snapshots, and assertSafeTarget has already
  // established that every anchor and corridor here is this script's own.
  await client.query("TRUNCATE rate_snapshots");
  await client.query("DELETE FROM anchor_corridors WHERE anchor_id IN (SELECT id FROM anchors WHERE slug LIKE 'bench-%')");
  await client.query("DELETE FROM anchors WHERE slug LIKE 'bench-%'");
  await client.query("DELETE FROM corridors WHERE slug LIKE 'bench-%'");
}

/**
 * Deterministic data: every value, including each snapshot id, is a pure
 * function of (anchor, corridor, k), so two runs seed identical tables.
 */
async function seed(client: Client, scenario: Scenario): Promise<number> {
  await clean(client);
  await client.query(
    `INSERT INTO anchors (slug, name, home_domain, toml_url, status)
     SELECT 'bench-anchor-' || a, 'Bench Anchor ' || a, 'anchor' || a || '.bench.invalid',
            'https://anchor' || a || '.bench.invalid/.well-known/stellar.toml', 'LIVE'
       FROM generate_series(0, $1 - 1) AS a`,
    [scenario.anchors],
  );
  await client.query(
    `INSERT INTO corridors (asset_code_from, country_from, asset_code_to, country_to, slug)
     SELECT 'USDC', 'US', 'C' || c, 'XX', 'bench-corridor-' || c
       FROM generate_series(0, $1 - 1) AS c`,
    [scenario.corridors],
  );
  await client.query(
    `INSERT INTO anchor_corridors (anchor_id, corridor_id)
     SELECT a.id, c.id FROM anchors a CROSS JOIN corridors c
      WHERE a.slug LIKE 'bench-%' AND c.slug LIKE 'bench-%'`,
  );
  await client.query(
    `WITH am AS (SELECT id, split_part(slug, '-', 3)::int AS ai FROM anchors WHERE slug LIKE 'bench-anchor-%'),
          cm AS (SELECT id, split_part(slug, '-', 3)::int AS ci FROM corridors WHERE slug LIKE 'bench-corridor-%')
     INSERT INTO rate_snapshots (id, anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at)
     SELECT md5(am.ai || '/' || cm.ci || '/' || k)::uuid, am.id, cm.id,
            1500 + ((am.ai * 31 + cm.ci * 17 + k * 7) % 1000) / 100.0,
            1, 1500 + ((am.ai * 31 + cm.ci * 17 + k * 7) % 1000) / 100.0, 0,
            $2::timestamptz - k * interval '1 minute'
       FROM am CROSS JOIN cm CROSS JOIN generate_series(0, $1 - 1) AS k`,
    [scenario.depth, SEED_BASE],
  );
  // Index-only scans need an up-to-date visibility map, and the planner needs
  // statistics: without both this measures an unrepresentative plan.
  await client.query("VACUUM (ANALYZE) rate_snapshots");
  await client.query("ANALYZE anchors");
  await client.query("ANALYZE corridors");
  const { rows } = await client.query<{ count: string }>("SELECT count(*) FROM rate_snapshots");
  return Number(rows[0]?.count);
}

async function explain(client: Client, query: Prisma.Sql): Promise<ExplainResult> {
  const { rows } = await client.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
    values: [...query.values],
  });
  return (rows[0] as { "QUERY PLAN": ExplainResult[] })["QUERY PLAN"][0]!;
}

async function timedRun(client: Client, query: Prisma.Sql) {
  const started = performance.now();
  const { rows } = await client.query({ text: query.text, values: [...query.values] });
  return { ms: performance.now() - started, rows };
}

async function measure(
  client: Client,
  query: Prisma.Sql,
  runs: number,
  coldRestart: (() => Promise<Client>) | undefined,
  setup: readonly string[],
) {
  let cold: ReturnType<typeof planMetrics> | undefined;
  let active = client;
  if (coldRestart) {
    active = await coldRestart();
    for (const statement of setup) await active.query(statement);
    cold = planMetrics(await explain(active, query));
  } else {
    for (const statement of setup) await active.query(statement);
  }
  for (let warmup = 0; warmup < 2; warmup += 1) await explain(active, query);

  const explained: ExplainResult[] = [];
  const roundTrips: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    explained.push(await explain(active, query));
    roundTrips.push((await timedRun(active, query)).ms);
  }
  const metrics = explained.map(planMetrics);
  const last = metrics[metrics.length - 1]!;
  // Session settings must not leak into the next variant.
  if (setup.length > 0) await active.query("RESET ALL");
  return {
    active,
    plan: explained[explained.length - 1]!,
    warm: {
      runs,
      // Server-side execution time from EXPLAIN ANALYZE; includes its timing
      // instrumentation overhead, so read it as a comparison, not a wall clock.
      executionMsMedian: round(median(metrics.map((entry) => entry.executionMs))),
      executionMsMin: round(Math.min(...metrics.map((entry) => entry.executionMs))),
      executionMsMax: round(Math.max(...metrics.map((entry) => entry.executionMs))),
      planningMsMedian: round(median(metrics.map((entry) => entry.planningMs))),
      // The plain query with no instrumentation, timed at the client. Includes
      // the round trip and result transfer.
      roundTripMsMedian: round(median(roundTrips)),
      rowsVisited: last.rowsVisited,
      heapFetches: last.heapFetches,
      sharedHitBlocks: last.sharedHitBlocks,
      sharedReadBlocks: last.sharedReadBlocks,
      scanNodes: last.scanNodes,
      queryCount: 1,
    },
    ...(cold ? { cold } : {}),
  };
}

function targets(client: Client) {
  return async () => {
    const [anchor, corridor] = await Promise.all([
      client.query<{ id: string }>("SELECT id FROM anchors WHERE slug = 'bench-anchor-0'"),
      client.query<{ id: string }>("SELECT id FROM corridors WHERE slug = 'bench-corridor-0'"),
    ]);
    return { anchorId: anchor.rows[0]!.id, corridorId: corridor.rows[0]!.id };
  };
}

async function waitForDatabase(url: string): Promise<Client> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const client = await connect(url);
      await client.query("SELECT 1");
      return client;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("PostgreSQL did not come back after the cold-restart command");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.BENCHMARK_DATABASE_URL;
  if (!url) {
    throw new Error("BENCHMARK_DATABASE_URL is required (a throwaway database, not DATABASE_URL).");
  }
  const restartCommand = process.env.BENCHMARK_COLD_RESTART_COMMAND;
  const selected = args.scenario ? SCENARIOS.filter(({ name }) => name === args.scenario) : SCENARIOS;
  if (selected.length === 0) throw new Error(`Unknown scenario. Choose from: ${SCENARIOS.map(({ name }) => name).join(", ")}`);

  let client = await connect(url);
  await assertSafeTarget(client);

  const settings = Object.fromEntries(
    (await client.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','jit','max_parallel_workers_per_gather')",
    )).rows.map(({ name, setting }) => [name, setting]),
  );
  const environment = {
    postgres: (await client.query<{ version: string }>("SELECT version()")).rows[0]!.version,
    settings,
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model.trim()} x${os.cpus().length}`,
    memoryGiB: round(os.totalmem() / 2 ** 30, 1),
    coldMethod: restartCommand
      ? "PostgreSQL restarted before one measurement (empty shared_buffers, warm OS page cache)"
      : "not measured",
    runsPerVariant: args.runs,
    // Timings are only comparable if the machine was quiet; rows visited and
    // buffers are deterministic either way. Recorded so a reader can tell.
    loadAverageAtStart: os.loadavg().map((value) => round(value, 2)),
  };

  const results: unknown[] = [];
  try {
    for (const scenario of selected) {
      const rows = await seed(client, scenario);
      const { anchorId, corridorId } = await targets(client)();
      const queries: Record<QueryName, Record<Variant, Prisma.Sql>> = {
        rates: { legacy: legacyLatestObservationsQuery(corridorId), lateral: latestObservationsQuery(corridorId) },
        reputation: { legacy: legacyLatestCorridorRatesQuery(anchorId), lateral: latestCorridorRatesQuery(anchorId) },
      };

      const scenarioResult: Record<string, unknown> = { ...scenario, snapshotRows: rows, queries: {} };
      for (const name of ["rates", "reputation"] as const) {
        // The two forms must agree before either is timed.
        const [before, after] = await Promise.all([
          timedRun(client, queries[name].legacy),
          timedRun(client, queries[name].lateral),
        ]);
        if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) {
          throw new Error(`${scenario.name}/${name}: legacy and lateral queries returned different rows`);
        }

        const perVariant: Record<string, unknown> = { resultRows: after.rows.length };
        for (const variant of VARIANTS) {
          const coldRestart = restartCommand
            ? async () => {
                await client.end().catch(() => undefined);
                execSync(restartCommand, { stdio: "ignore" });
                client = await waitForDatabase(url);
                return client;
              }
            : undefined;
          const measured = await measure(client, queries[name][variant.query], args.runs, coldRestart, variant.setup);
          const { plan, active, ...report } = measured;
          client = active;
          perVariant[variant.name] = report;
          if (args.plansDir && scenario.name === PLAN_SCENARIO) {
            mkdirSync(args.plansDir, { recursive: true });
            writeFileSync(join(args.plansDir, `${name}-${variant.name}.json`), `${JSON.stringify([plan], null, 2)}\n`);
          }
        }
        (scenarioResult.queries as Record<string, unknown>)[name] = perVariant;
      }
      results.push(scenarioResult);
      console.error(`done ${scenario.name} (${rows} rows)`);
    }
  } finally {
    await clean(client).catch((error) => console.error("cleanup failed:", error instanceof Error ? error.message : error));
    await client.end().catch(() => undefined);
  }

  const output = `${JSON.stringify({ environment, scenarios: results }, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, output);
  else process.stdout.write(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
