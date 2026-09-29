import assert from "node:assert/strict";
import { after, test } from "node:test";

import { SpanStatusCode, trace } from "@opentelemetry/api";

import { getAnchorsApiResult } from "@/lib/api/anchors";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import { fetchSep1Toml, Sep1DiscoveryError } from "@/lib/stellar/sep1";
import { getSep38FirmQuote, getSep38Info, Sep38ClientError } from "@/lib/stellar/sep38";
import { currentTraceContext, observeConnectionPool } from "@/lib/telemetry/core";
import { observeDatabaseOperation } from "@/lib/telemetry/database";
import { withRouteTelemetry } from "@/lib/telemetry/route";
import { METRIC } from "@/lib/telemetry/semantics";
import {
  exportedText,
  findSpan,
  installTestTelemetry,
  isChildOf,
  pointWith,
} from "@/tests/support/telemetry";

const telemetry = installTestTelemetry();
after(() => telemetry.sdk.shutdown());

const ANCHOR_HOST = "secret-anchor.example.com";
const TOKEN = "super-secret-jwt-token";
const TOML = [
  'NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
  `ANCHOR_QUOTE_SERVER="https://${ANCHOR_HOST}/sep38"`,
  "[DOCUMENTATION]",
  'ORG_NAME="Synthetic Anchor"',
].join("\n");

function fakeFetch(responses: Record<string, () => Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const match = Object.keys(responses).find((path) => url.includes(path));
    if (!match) throw new Error(`unexpected request to ${url}`);
    return responses[match]!();
  }) as typeof fetch;
}

const anchorsHandler = withRouteTelemetry("/api/anchors", async () => {
  const result = await getAnchorsApiResult({
    repository: {
      findAll: () => observeDatabaseOperation(
        { client: "default", model: "Anchor", operation: "findMany" },
        async () => [],
      ),
      findBySlug: async () => null,
    },
  });
  return Response.json(result.body, { status: result.status });
});

test("a public route span parents the repository database span in one trace", async () => {
  telemetry.resetSpans();
  const response = await anchorsHandler();

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).anchors, []);
  const spans = telemetry.spans();
  const route = findSpan(spans, "GET /api/anchors");
  const database = findSpan(spans, "findMany Anchor");
  assert.ok(isChildOf(database, route), "database span must be a child of the route span");
  assert.equal(route.attributes["http.route"], "/api/anchors");
  assert.equal(route.attributes["http.response.status_code"], 200);
  assert.equal(database.attributes["db.system.name"], "postgresql");
  assert.equal(database.attributes["db.collection.name"], "Anchor");

  const durations = await telemetry.points(METRIC.httpDuration);
  assert.ok(pointWith(durations, {
    "http.route": "/api/anchors",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "stellarcore.result": "ok",
  }));
  const active = pointWith(await telemetry.points(METRIC.httpActive), { "http.route": "/api/anchors" });
  assert.equal(active?.value, 0, "in-flight gauge returns to zero after the request");
  assert.ok(pointWith(await telemetry.points(METRIC.dbDuration), {
    "db.operation.name": "findMany",
    "db.collection.name": "Anchor",
    "stellarcore.db.client": "default",
  }));
});

test("a failing repository keeps the safe error envelope and records a bounded error", async () => {
  telemetry.resetSpans();
  const handler = withRouteTelemetry("/api/anchors", async () => {
    const result = await getAnchorsApiResult({
      repository: {
        findAll: () => observeDatabaseOperation(
          { client: "default", model: "Anchor", operation: "findMany" },
          async () => {
            throw Object.assign(new Error("connect postgresql://user:pw@db.internal/app failed"), {
              code: "ECONNREFUSED",
            });
          },
        ),
        findBySlug: async () => null,
      },
    });
    return Response.json(result.body, { status: result.status });
  });

  const response = await handler();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "internal_error", message: "Unable to load anchors." },
  });
  const spans = telemetry.spans();
  const database = findSpan(spans, "findMany Anchor");
  assert.equal(database.attributes["error.type"], "ECONNREFUSED");
  assert.equal(database.status.code, SpanStatusCode.ERROR);
  assert.equal(findSpan(spans, "GET /api/anchors").attributes["error.type"], "500");
  assert.doesNotMatch(exportedText(spans), /postgresql:|db\.internal|pw@/);
  assert.ok(pointWith(await telemetry.points(METRIC.httpDuration), {
    "http.route": "/api/anchors",
    "stellarcore.result": "server_error",
  }));
});

test("a scheduled refresh parents phase, SEP, and database spans without leaking hosts or tokens", async () => {
  telemetry.resetSpans();
  const fetcher = fakeFetch({
    "/.well-known/stellar.toml": () => new Response(TOML, { status: 200 }),
    "/sep38/info": () => new Response("unavailable", { status: 503 }),
    "/sep38/quote/": () => new Response("{}", { status: 401 }),
  });

  const result = await runScheduledRefresh({
    now: () => new Date("2026-09-29T00:00:00.000Z"),
    snapshotRates: async () => {
      await fetchSep1Toml(ANCHOR_HOST, { fetcher });
      await assert.rejects(
        getSep38Info(`https://${ANCHOR_HOST}/sep38`, { fetcher }),
        (error: unknown) => error instanceof Sep38ClientError && error.code === "HTTP_FAILURE",
      );
      await assert.rejects(
        getSep38FirmQuote(`https://${ANCHOR_HOST}/sep38`, "quote-123", { token: TOKEN }, { fetcher }),
        (error: unknown) => error instanceof Sep38ClientError && error.code === "HTTP_FAILURE",
      );
      await observeDatabaseOperation(
        { client: "default", model: "RateSnapshot", operation: "create" },
        async () => ({ id: "synthetic" }),
      );
      return {
        totalCandidates: 1,
        totalAttempted: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        snapshotsPersisted: 1,
        snapshots: [],
        failures: [],
        skippedSources: [],
      };
    },
    evaluateReputation: async () => ({ attempted: 2, succeeded: 1, failed: 1, failures: [
      { anchorSlug: "synthetic-anchor", code: "PERSISTENCE_FAILURE" },
    ] }),
  });

  assert.equal(result.ok, false);
  const spans = telemetry.spans();
  const run = findSpan(spans, "stellarcore.refresh.run");
  const rates = findSpan(spans, "stellarcore.refresh.phase rates");
  const reputation = findSpan(spans, "stellarcore.refresh.phase reputation");
  const toml = findSpan(spans, "SEP-1 toml");
  const info = findSpan(spans, "SEP-38 info");
  const persist = findSpan(spans, "create RateSnapshot");
  const quote = findSpan(spans, "SEP-38 quote");

  assert.ok(isChildOf(rates, run));
  assert.ok(isChildOf(reputation, run));
  assert.ok(isChildOf(toml, rates));
  assert.ok(isChildOf(info, rates));
  assert.ok(isChildOf(persist, rates));
  assert.ok(isChildOf(quote, rates));
  assert.equal(quote.attributes["http.response.status_code"], 401);
  assert.equal(info.attributes["error.type"], "HTTP_FAILURE");
  assert.equal(info.attributes["http.response.status_code"], 503);
  assert.equal(run.attributes["stellarcore.result"], "partial_failure");
  assert.equal(reputation.attributes["stellarcore.result"], "partial_failure");

  const text = exportedText(spans);
  for (const forbidden of [ANCHOR_HOST, TOKEN, "Bearer", "quote-123", "https://", "stellar.toml", "synthetic-anchor"]) {
    assert.equal(text.includes(forbidden), false, `exported telemetry contains ${forbidden}`);
  }

  assert.ok(pointWith(await telemetry.points(METRIC.sepDuration), {
    "stellarcore.sep": "38",
    "stellarcore.sep.operation": "info",
    "stellarcore.result": "HTTP_FAILURE",
  }));
  assert.ok(pointWith(await telemetry.points(METRIC.sepDuration), {
    "stellarcore.sep": "1",
    "stellarcore.sep.operation": "toml",
    "stellarcore.result": "OK",
  }));
  assert.equal(pointWith(await telemetry.points(METRIC.refreshRuns), {
    "stellarcore.result": "partial_failure",
  })?.value, 1);
  assert.equal(pointWith(await telemetry.points(METRIC.refreshPhaseItems), {
    "stellarcore.refresh.phase": "reputation",
    "stellarcore.refresh.item_result": "failed",
  })?.value, 1);
  assert.ok(pointWith(await telemetry.points(METRIC.refreshPhaseDuration), {
    "stellarcore.refresh.phase": "rates",
    "stellarcore.result": "success",
  }));
});

test("a fatal refresh failure still records a failed run and rethrows unchanged", async () => {
  const fatal = new Error("fatal");
  await assert.rejects(runScheduledRefresh({
    now: () => new Date(),
    snapshotRates: async () => { throw new Error("preparation"); },
    evaluateReputation: async () => { throw fatal; },
  }), (error) => error === fatal);
  assert.equal(pointWith(await telemetry.points(METRIC.refreshRuns), {
    "stellarcore.result": "failure",
  })?.value, 1);
});

test("SEP typed failure classifications are preserved through instrumentation", async () => {
  await assert.rejects(
    fetchSep1Toml(ANCHOR_HOST, { fetcher: (async () => { throw new TypeError("socket"); }) as typeof fetch }),
    (error: unknown) => error instanceof Sep1DiscoveryError && error.code === "NETWORK_FAILURE",
  );
  assert.ok(pointWith(await telemetry.points(METRIC.sepDuration), {
    "stellarcore.sep": "1",
    "stellarcore.result": "NETWORK_FAILURE",
  }));
});

test("spans from other libraries are redacted at the export boundary", () => {
  telemetry.resetSpans();
  const span = trace.getTracer("next.js").startSpan(`fetch GET https://${ANCHOR_HOST}/sep38/price?sell_asset=x`, {
    attributes: {
      "http.route": "/api/rates",
      "http.target": "/api/rates?corridor=usdc-us-brl-br",
      "url.full": `https://user:pass@${ANCHOR_HOST}/x`,
      "db.query.text": "SELECT * FROM anchors",
      "authorization": `Bearer ${TOKEN}`,
      "stellarcore.result": `https://${ANCHOR_HOST}`,
    },
  });
  span.recordException(new Error(`failed https://${ANCHOR_HOST}?token=${TOKEN}`));
  span.setStatus({ code: SpanStatusCode.ERROR, message: `https://${ANCHOR_HOST}` });
  span.end();

  const [exported] = telemetry.spans();
  assert.equal(exported!.name, "fetch GET");
  assert.deepEqual(exported!.attributes, { "http.route": "/api/rates" });
  assert.deepEqual(exported!.events, []);
  assert.equal(exported!.status.message, undefined);
});

test("rate freshness metrics describe persisted observations without creating evidence", async () => {
  const evaluatedAt = new Date("2026-09-29T12:00:00.000Z");
  const calls: string[] = [];
  const result = await readLatestCorridorRate("usdc-us-brl-br", {
    evaluatedAt,
    repository: {
      findCorridorBySlug: async () => {
        calls.push("corridor");
        return {
          id: "corridor-id",
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        };
      },
      findLatestObservations: async () => {
        calls.push("observations");
        return [
          observation("a", "anchor-a", new Date(evaluatedAt.getTime() - 60_000)),
          observation("b", "anchor-b", new Date(evaluatedAt.getTime() - 3 * 86_400_000)),
        ];
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["corridor", "observations"], "telemetry performs no extra reads");
  const observations = await telemetry.points(METRIC.rateObservations);
  assert.equal(pointWith(observations, { "stellarcore.freshness.state": "fresh" })?.value, 1);
  assert.equal(pointWith(observations, { "stellarcore.freshness.state": "stale" })?.value, 1);
  const ages = await telemetry.points(METRIC.rateObservationAge);
  const staleAge = pointWith(ages, { "stellarcore.freshness.state": "stale" })?.value as { max?: number };
  assert.equal(staleAge.max, 3 * 86_400);
  for (const point of [...observations, ...ages]) {
    assert.deepEqual(Object.keys(point.attributes), ["stellarcore.freshness.state"]);
  }
});

test("connection pool pressure is observable before any timeout", async () => {
  observeConnectionPool("test-pool", { totalCount: 10, idleCount: 0, waitingCount: 7 });
  const connections = await telemetry.points(METRIC.dbConnections);
  assert.equal(pointWith(connections, {
    "db.client.connection.pool.name": "test-pool",
    "db.client.connection.state": "used",
  })?.value, 10);
  assert.equal(pointWith(await telemetry.points(METRIC.dbPending), {
    "db.client.connection.pool.name": "test-pool",
  })?.value, 7);
});

test("the active trace context is available for log correlation", async () => {
  assert.equal(currentTraceContext(), undefined);
  await withRouteTelemetry("/api/corridors", async () => {
    const context = currentTraceContext();
    assert.match(context?.traceId ?? "", /^[0-9a-f]{32}$/);
    assert.match(context?.spanId ?? "", /^[0-9a-f]{16}$/);
    return new Response(null, { status: 204 });
  })();
});

function observation(id: string, anchorSlug: string, capturedAt: Date) {
  return {
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate: "5.1",
    sourceAmount: "100",
    destinationAmount: "510",
    fee: "0",
    capturedAt,
  };
}
