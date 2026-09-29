import "dotenv/config";

import { pathToFileURL } from "node:url";

import { db } from "@/lib/dbClient";

/**
 * Deterministic load-test dataset for tests/load/api-load.js (#63).
 *
 * Every row this writes is SYNTHETIC and clearly labelled as such: all slugs
 * carry the `loadtest-` prefix, so the data can never be mistaken for — or
 * collide with — the reviewed registry that `bootstrap:registry` maintains,
 * and `--teardown` removes exactly this prefix and nothing else. Run it only
 * against a local or staging database; the numbers it enables are load
 * measurements, never product evidence, and must not be presented through
 * the public UI as real Stellar activity.
 *
 * Deterministic on purpose (no RNG): a fresh checkout that runs this gets
 * byte-identical rows, so a rerun of the documented k6 ladder measures the
 * implementation, not the dataset. Values derive from index arithmetic only.
 *
 *   ANCHORS=24 CORRIDORS=4 DAYS=90 npx tsx tests/load/seed.ts
 *   npx tsx tests/load/seed.ts --teardown
 *
 * Defaults reproduce the dataset documented in docs/load-testing.md:
 * 24 anchors x 4 corridors x 90 days of hourly quotes = 207,360 snapshots,
 * plus daily transfer outcomes and one reputation score per anchor.
 */

const ANCHORS = Number(process.env.ANCHORS ?? 24);
const CORRIDORS = Number(process.env.CORRIDORS ?? 4);
const DAYS = Number(process.env.DAYS ?? 90);

/** The single place the synthetic namespace is defined. */
export const LOADTEST_PREFIX = "loadtest-";

async function teardown(): Promise<void> {
  // FK order: children first (Restrict, not Cascade), scoped to the prefix.
  const deleted = await db.$executeRaw`
    DELETE FROM rate_snapshots WHERE anchor_id IN
      (SELECT id FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"})`;
  await db.$executeRaw`
    DELETE FROM transfer_outcomes WHERE anchor_id IN
      (SELECT id FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"})`;
  await db.$executeRaw`
    DELETE FROM reputation_scores WHERE anchor_id IN
      (SELECT id FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"})`;
  await db.$executeRaw`
    DELETE FROM anchor_corridors WHERE anchor_id IN
      (SELECT id FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"})`;
  await db.$executeRaw`DELETE FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"}`;
  await db.$executeRaw`DELETE FROM corridors WHERE slug LIKE ${LOADTEST_PREFIX + "%"}`;
  process.stdout.write(`teardown complete (removed ${deleted}+ loadtest-prefixed rows)\n`);
}

async function seed(): Promise<void> {
  // Refuse to double-seed: determinism includes "running it twice is a no-op
  // you are told about", not a doubled dataset that skews the measurements.
  const existing = await db.anchor.count({ where: { slug: { startsWith: LOADTEST_PREFIX } } });
  if (existing > 0) {
    process.stdout.write(
      `load-test data already present (${existing} anchors); run with --teardown first for a clean reseed\n`,
    );
    process.exitCode = 1;
    return;
  }

  await db.$executeRaw`
    INSERT INTO anchors (slug, name, home_domain, toml_url, status)
    SELECT ${LOADTEST_PREFIX} || 'anchor-' || i,
           'Load-test anchor ' || i,
           'loadtest-' || i || '.invalid',
           'https://loadtest-' || i || '.invalid/.well-known/stellar.toml',
           'LIVE'
    FROM generate_series(1, ${ANCHORS}::int) i`;

  await db.$executeRaw`
    INSERT INTO corridors (asset_code_from, country_from, asset_code_to, country_to, slug)
    SELECT 'USDC', 'US', 'NGNC', 'NG', ${LOADTEST_PREFIX} || 'usdc-ngn-' || i
    FROM generate_series(1, ${CORRIDORS}::int) i`;

  await db.$executeRaw`
    INSERT INTO anchor_corridors (anchor_id, corridor_id)
    SELECT a.id, c.id FROM anchors a CROSS JOIN corridors c
    WHERE a.slug LIKE ${LOADTEST_PREFIX + "%"} AND c.slug LIKE ${LOADTEST_PREFIX + "%"}`;

  // Hourly quotes for DAYS days. Rates are index arithmetic, not random():
  // rate(i) = 1500 + (i * 7 mod 200) / 10 — spread enough to exercise the
  // median math, identical on every machine.
  await db.$executeRaw`
    INSERT INTO rate_snapshots (anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at)
    SELECT a.id, c.id,
           1500 + ((h * 7) % 200) / 10.0,
           100, 150000, 0.5,
           now() - (h || ' hours')::interval
    FROM anchors a
    CROSS JOIN corridors c
    CROSS JOIN generate_series(0, ${DAYS * 24 - 1}::int) h
    WHERE a.slug LIKE ${LOADTEST_PREFIX + "%"} AND c.slug LIKE ${LOADTEST_PREFIX + "%"}`;

  await db.$executeRaw`
    INSERT INTO transfer_outcomes (anchor_id, corridor_id, status, fill_rate, settlement_ms, slippage, recorded_at)
    SELECT a.id, c.id, 'COMPLETED', 0.99, 30000 + (d * 137) % 20000, 0.001,
           now() - (d || ' days')::interval
    FROM anchors a
    CROSS JOIN corridors c
    CROSS JOIN generate_series(0, ${DAYS - 1}::int) d
    WHERE a.slug LIKE ${LOADTEST_PREFIX + "%"} AND c.slug LIKE ${LOADTEST_PREFIX + "%"}`;

  await db.$executeRaw`
    INSERT INTO reputation_scores (anchor_id, composite_score, score_band, fill_rate_7d, fill_rate_30d, fill_rate_90d,
                                   settle_p50_ms, settle_p95_ms, slippage_p50, slippage_p95, sample_size, state)
    SELECT id, 0.92, 'green', 0.99, 0.98, 0.97, 31000, 48000, 0.001, 0.004, ${DAYS * CORRIDORS}::int, 'ok'
    FROM anchors WHERE slug LIKE ${LOADTEST_PREFIX + "%"}`;

  await db.$executeRaw`ANALYZE`;

  const snapshots = await db.rateSnapshot.count();
  process.stdout.write(
    JSON.stringify({
      anchors: ANCHORS,
      corridors: CORRIDORS,
      days: DAYS,
      snapshots,
      prefix: LOADTEST_PREFIX,
    }) + "\n",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--teardown")) await teardown();
  else await seed();
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
