import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METRIC } from "@/lib/telemetry/semantics";
import {
  exportedText,
  findSpan,
  installTestTelemetry,
  isChildOf,
  pointWith,
} from "@/tests/support/telemetry";

/**
 * Verifies trace context across the real route handler, repository, Prisma,
 * and PostgreSQL, and across the scheduled refresh into reputation
 * persistence. Uses an in-memory exporter and synthetic fixtures only.
 *
 * Opt-in: RUN_TELEMETRY_DATABASE_INTEGRATION=1 with DATABASE_URL pointing at
 * an isolated, migrated database.
 */
const ENABLED = process.env.RUN_TELEMETRY_DATABASE_INTEGRATION === "1";
const telemetry = ENABLED ? installTestTelemetry() : undefined;

const suffix = randomUUID().replaceAll("-", "");
const anchorSlug = `telemetry-fixture-${suffix}`;

type Db = typeof import("@/lib/dbClient").db;
let db: Db | undefined;

before(async () => {
  if (!ENABLED) return;
  await import("dotenv/config");
  ({ db } = await import("@/lib/dbClient"));
  await db.anchor.create({
    data: {
      slug: anchorSlug,
      name: "Telemetry Fixture",
      homeDomain: `${suffix}.example.com`,
      tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
      status: "LIVE",
    },
  });
});

after(async () => {
  if (!db) return;
  await db.reputationScore.deleteMany({ where: { anchor: { slug: anchorSlug } } });
  await db.anchor.deleteMany({ where: { slug: anchorSlug } });
  await db.$disconnect();
  await telemetry?.sdk.shutdown();
});

test("the anchors route traces into real Prisma operations without leaking data", { skip: !ENABLED }, async () => {
  telemetry!.resetSpans();
  const { GET } = await import("@/app/api/anchors/route");
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json() as { anchors: { slug: string }[] };
  assert.ok(body.anchors.some(({ slug }) => slug === anchorSlug));

  const spans = telemetry!.spans();
  const route = findSpan(spans, "GET /api/anchors");
  const query = findSpan(spans, "findMany Anchor");
  assert.ok(isChildOf(query, route), "Prisma span must be a child of the route span");

  const text = exportedText(spans);
  for (const forbidden of [anchorSlug, suffix, "postgresql://", "SELECT", process.env.DATABASE_URL ?? "unset"]) {
    assert.equal(text.includes(forbidden), false, `exported telemetry contains ${forbidden.slice(0, 20)}`);
  }

  assert.ok(pointWith(await telemetry!.points(METRIC.dbDuration), {
    "db.operation.name": "findMany",
    "db.collection.name": "Anchor",
  }));
  const connections = await telemetry!.points(METRIC.dbConnections);
  assert.ok(pointWith(connections, {
    "db.client.connection.pool.name": "default",
    "db.client.connection.state": "idle",
  }), "the real pool is observed");
  assert.ok(pointWith(await telemetry!.points(METRIC.dbPending), {
    "db.client.connection.pool.name": "default",
  }));
});

test("a scheduled refresh traces into reputation persistence", { skip: !ENABLED }, async () => {
  telemetry!.resetSpans();
  const { runScheduledRefresh } = await import("@/lib/scheduled/refresh");
  const { evaluatePersistedAnchorReputations } = await import("@/lib/reputation/run");

  const result = await runScheduledRefresh({
    now: () => new Date(),
    snapshotRates: async () => ({
      totalCandidates: 0, totalAttempted: 0, succeeded: 0, failed: 0, skipped: 0,
      snapshotsPersisted: 0, snapshots: [], failures: [], skippedSources: [],
    }),
    evaluateReputation: (options) => evaluatePersistedAnchorReputations({
      ...options,
      anchorSlugs: [anchorSlug],
    }),
  });
  assert.equal(result.ok, true);

  const spans = telemetry!.spans();
  const run = findSpan(spans, "stellarcore.refresh.run");
  const phase = findSpan(spans, "stellarcore.refresh.phase reputation");
  const upsert = findSpan(spans, "upsert ReputationScore");
  assert.ok(isChildOf(phase, run));
  assert.equal(upsert.spanContext().traceId, run.spanContext().traceId);
  let ancestor = spans.find((span) => span.spanContext().spanId === upsert.parentSpanContext?.spanId);
  while (ancestor && ancestor !== phase) {
    const parentId = ancestor.parentSpanContext?.spanId;
    ancestor = spans.find((span) => span.spanContext().spanId === parentId);
  }
  assert.equal(ancestor, phase, "reputation persistence must descend from the reputation phase");
  assert.equal(exportedText(spans).includes(anchorSlug), false);
});
