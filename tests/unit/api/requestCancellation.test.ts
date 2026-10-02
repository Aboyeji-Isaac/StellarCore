import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as anchorListRoute from "@/app/api/anchors/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as corridorListRoute from "@/app/api/corridors/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import * as reputationListRoute from "@/app/api/reputation/route";
import { getAnchorApiResult, getAnchorsApiResult } from "@/lib/api/anchors";
import type {
  AnchorDetailRecord,
  AnchorDirectoryRecord,
  AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
import { getCorridorApiResult, getCorridorsApiResult } from "@/lib/api/corridors";
import type {
  CorridorDetailRecord,
  CorridorDirectoryRecord,
  CorridorDirectoryRepository,
  CorridorDetailRepository,
} from "@/lib/api/corridorRepository";
import { getRatesApiResult } from "@/lib/api/rates";
import { getAnchorReputationApiResult, getReputationApiResult } from "@/lib/api/reputation";
import type {
  ReputationApiAnchorRecord,
  ReputationApiRepository,
} from "@/lib/api/reputationRepository";
import {
  createRequestContext,
  isRequestCancellationError,
  runWithinContext,
} from "@/lib/api/requestContext";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import type { LatestRateRepository } from "@/types/latestRates";
import type { RequestContext } from "@/types/api/requestContext";

const SLUG = "zeam";
const CORRIDOR = "usdc-us-brl-br";

test("an aborted caller stops every public read before repository access", async () => {
  const anchors = trackingAnchors();
  const corridors = trackingCorridors();
  const reputation = trackingReputation();
  const rates = trackingRatesReadModel();
  const context = abortedContext();

  const reads: readonly Readonly<{
    name: string;
    run: () => Promise<unknown>;
    accesses: () => number;
  }>[] = [
    {
      name: "anchor list",
      run: () => getAnchorsApiResult({ repository: anchors.repository, context }),
      accesses: () => anchors.accesses.findAll,
    },
    {
      name: "anchor detail",
      run: () => getAnchorApiResult(SLUG, { repository: anchors.repository, context }),
      accesses: () => anchors.accesses.findBySlug,
    },
    {
      name: "corridor list",
      run: () => getCorridorsApiResult({ repository: corridors.repository, context }),
      accesses: () => corridors.accesses.findAll,
    },
    {
      name: "corridor detail",
      run: () => getCorridorApiResult(CORRIDOR, { repository: corridors.detail, context }),
      accesses: () => corridors.accesses.findBySlug,
    },
    {
      name: "reputation list",
      run: () => getReputationApiResult({ repository: reputation.repository, context }),
      accesses: () => reputation.accesses.findAll,
    },
    {
      name: "reputation detail",
      run: () => getAnchorReputationApiResult(SLUG, {
        repository: reputation.repository,
        context,
      }),
      accesses: () => reputation.accesses.findBySlug,
    },
    {
      name: "rates",
      run: () => getRatesApiResult(CORRIDOR, { readLatestRate: rates.read, context }),
      accesses: () => rates.accesses.read,
    },
    {
      name: "latest-rate read model",
      run: () => readLatestCorridorRate(CORRIDOR, { repository: rates.repository, context }),
      accesses: () => rates.accesses.findCorridorBySlug,
    },
  ];

  for (const read of reads) {
    await assert.rejects(
      read.run(),
      (error: unknown) =>
        isRequestCancellationError(error) && error.reason === "client_aborted",
      read.name,
    );
    assert.equal(read.accesses(), 0, read.name);
  }

  context.dispose();
});

test("a deadline that expires before database acquisition never starts repository work", async () => {
  let clock = 1_000;
  const context = createRequestContext({ budgetMs: 500, now: () => clock });
  const anchors = trackingAnchors();

  clock = 1_500;
  await assert.rejects(
    getAnchorsApiResult({ repository: anchors.repository, context }),
    (error: unknown) =>
      isRequestCancellationError(error) && error.reason === "deadline_exceeded",
  );
  assert.equal(anchors.accesses.findAll, 0);

  context.dispose();
});

test("a deadline that expires while a read is in flight skips serialization", async () => {
  let clock = 1_000;
  let reads = 0;
  const context = createRequestContext({ budgetMs: 500, now: () => clock });
  const repository: AnchorDirectoryRepository = {
    findAll: async () => {
      reads += 1;
      clock = 1_501;
      return [anchorSummary()];
    },
    findBySlug: async () => null,
  };

  await assert.rejects(
    getAnchorsApiResult({ repository, context }),
    (error: unknown) =>
      isRequestCancellationError(error) && error.reason === "deadline_exceeded",
  );
  // The acquisition finished, but the deadline expired before serialization,
  // so no success payload is ever produced.
  assert.equal(reads, 1);

  context.dispose();
});

test("a deadline between two sequential reads stops the second read", async () => {
  let clock = 1_000;
  const context = createRequestContext({ budgetMs: 500, now: () => clock });
  const repository: LatestRateRepository = {
    findCorridorBySlug: async () => {
      clock = 1_501;
      return {
        id: "corridor-id",
        slug: CORRIDOR,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      };
    },
    findLatestObservations: async () => {
      throw new Error("the second read must never start");
    },
  };

  await assert.rejects(
    readLatestCorridorRate(CORRIDOR, { repository, context }),
    (error: unknown) =>
      isRequestCancellationError(error) && error.reason === "deadline_exceeded",
  );

  context.dispose();
});

test("a statement still in flight when the budget expires stops waiting", async (t) => {
  // The production timer is deliberately unref'd, so a real-time wait would
  // let an idle test process exit first; mocked ticks keep this deterministic.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = createRequestContext({ budgetMs: 25 });
  // Assigned synchronously when the statement promise is constructed.
  let settle!: () => void;
  const statement = new Promise<readonly AnchorDirectoryRecord[]>((resolve) => {
    settle = () => resolve([anchorSummary()]);
  });
  const repository: AnchorDirectoryRepository = {
    findAll: (statementContext) =>
      runWithinContext(statementContext, () => statement),
    findBySlug: async () => null,
  };

  const pending = getAnchorsApiResult({ repository, context });
  t.mock.timers.tick(25);

  await assert.rejects(
    pending,
    (error: unknown) =>
      isRequestCancellationError(error) && error.reason === "deadline_exceeded",
  );
  assert.equal(context.cancellationReason(), "deadline_exceeded");

  // The losing statement settles afterwards; its outcome is discarded rather
  // than surfacing as an unhandled rejection.
  settle();
  await Promise.resolve();
  assert.equal(context.cancellationReason(), "deadline_exceeded");

  context.dispose();
});

test("a live context leaves successful payloads unchanged", async () => {
  const context = createRequestContext({ budgetMs: 5_000 });

  assert.deepEqual(
    await getAnchorsApiResult({ repository: trackingAnchors().repository, context }),
    await getAnchorsApiResult({ repository: trackingAnchors().repository }),
  );
  assert.deepEqual(
    await getAnchorApiResult(SLUG, { repository: trackingAnchors().repository, context }),
    await getAnchorApiResult(SLUG, { repository: trackingAnchors().repository }),
  );
  assert.deepEqual(
    await getCorridorsApiResult({ repository: trackingCorridors().repository, context }),
    await getCorridorsApiResult({ repository: trackingCorridors().repository }),
  );
  assert.deepEqual(
    await getCorridorApiResult(CORRIDOR, {
      repository: trackingCorridors().detail,
      context,
    }),
    await getCorridorApiResult(CORRIDOR, { repository: trackingCorridors().detail }),
  );
  assert.deepEqual(
    await getReputationApiResult({
      repository: trackingReputation().repository,
      context,
    }),
    await getReputationApiResult({ repository: trackingReputation().repository }),
  );
  assert.deepEqual(
    await getAnchorReputationApiResult(SLUG, {
      repository: trackingReputation().repository,
      context,
    }),
    await getAnchorReputationApiResult(SLUG, {
      repository: trackingReputation().repository,
    }),
  );
  const evaluatedAt = new Date("2026-08-28T12:00:00.000Z");
  assert.deepEqual(
    await readLatestCorridorRate(CORRIDOR, {
      repository: trackingRatesReadModel().repository,
      evaluatedAt,
      context,
    }),
    await readLatestCorridorRate(CORRIDOR, {
      repository: trackingRatesReadModel().repository,
      evaluatedAt,
    }),
  );

  context.dispose();
});

test("every public read route answers a disconnected caller with 499 and no body", async () => {
  const caller = new AbortController();
  caller.abort();
  const request = (url: string) => new Request(url, { signal: caller.signal });
  const routeParams = { params: Promise.resolve({ slug: SLUG }) };

  const routes: readonly Readonly<{
    name: string;
    response: () => Promise<Response>;
  }>[] = [
    { name: "anchor list", response: () => anchorListRoute.GET(request("http://localhost/api/anchors")) },
    { name: "anchor detail", response: () => anchorDetailRoute.GET(request(`http://localhost/api/anchors/${SLUG}`), routeParams) },
    { name: "corridor list", response: () => corridorListRoute.GET(request("http://localhost/api/corridors")) },
    { name: "corridor detail", response: () => corridorDetailRoute.GET(request(`http://localhost/api/corridors/${CORRIDOR}`), { params: Promise.resolve({ slug: CORRIDOR }) }) },
    { name: "rates", response: () => ratesRoute.GET(request(`http://localhost/api/rates?corridor=${CORRIDOR}`)) },
    { name: "reputation list", response: () => reputationListRoute.GET(request("http://localhost/api/reputation")) },
    { name: "reputation detail", response: () => reputationDetailRoute.GET(request(`http://localhost/api/reputation/${SLUG}`), routeParams) },
  ];

  for (const route of routes) {
    const response = await route.response();

    assert.equal(response.status, 499, route.name);
    assert.equal(response.headers.get("cache-control"), "no-store", route.name);
    assert.equal(await response.text(), "", route.name);
  }
});

function abortedContext(): RequestContext {
  const caller = new AbortController();
  caller.abort();
  return createRequestContext({ budgetMs: 60_000, signal: caller.signal });
}

function anchorSummary(): AnchorDirectoryRecord {
  return Object.freeze({
    slug: SLUG,
    name: "Zeam",
    homeDomain: "zeam.example",
    status: "LIVE",
    seps: Object.freeze([1, 38]),
    corridorCount: 1,
  });
}

function anchorDetail(): AnchorDetailRecord {
  return Object.freeze({ ...anchorSummary(), corridors: Object.freeze([]) });
}

function corridorSummary(): CorridorDirectoryRecord {
  return Object.freeze({
    slug: CORRIDOR,
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchorCount: 1,
  });
}

function corridorDetail(): CorridorDetailRecord {
  return Object.freeze({
    slug: CORRIDOR,
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchors: Object.freeze([]),
  });
}

function reputationRecord(): ReputationApiAnchorRecord {
  return Object.freeze({
    slug: SLUG,
    name: "Zeam",
    reputationScore: Object.freeze({
      compositeScore: null,
      scoreBand: null,
      fillRate7d: null,
      fillRate30d: null,
      fillRate90d: null,
      settleP50Ms: null,
      settleP95Ms: null,
      slippageP50: null,
      slippageP95: null,
      sampleSize: 0,
      state: "INSUFFICIENT_DATA",
      computedAt: new Date("2026-08-28T12:00:00.000Z"),
    }),
  });
}

function trackingAnchors() {
  const accesses = { findAll: 0, findBySlug: 0 };
  const repository: AnchorDirectoryRepository = Object.freeze({
    findAll: async () => {
      accesses.findAll += 1;
      return [anchorSummary()];
    },
    findBySlug: async () => {
      accesses.findBySlug += 1;
      return anchorDetail();
    },
  });
  return { repository, accesses };
}

function trackingCorridors() {
  const accesses = { findAll: 0, findBySlug: 0 };
  const repository: CorridorDirectoryRepository = Object.freeze({
    findAll: async () => {
      accesses.findAll += 1;
      return [corridorSummary()];
    },
  });
  const detail: CorridorDetailRepository = Object.freeze({
    findBySlug: async () => {
      accesses.findBySlug += 1;
      return corridorDetail();
    },
  });
  return { repository, detail, accesses };
}

function trackingReputation() {
  const accesses = { findAll: 0, findBySlug: 0 };
  const repository: ReputationApiRepository = Object.freeze({
    findAll: async () => {
      accesses.findAll += 1;
      return [reputationRecord()];
    },
    findBySlug: async () => {
      accesses.findBySlug += 1;
      return reputationRecord();
    },
  });
  return { repository, accesses };
}

function trackingRatesReadModel() {
  const accesses = {
    read: 0,
    findCorridorBySlug: 0,
    findLatestObservations: 0,
  };
  const repository: LatestRateRepository = Object.freeze({
    findCorridorBySlug: async () => {
      accesses.findCorridorBySlug += 1;
      return {
        id: "corridor-id",
        slug: CORRIDOR,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      };
    },
    findLatestObservations: async () => {
      accesses.findLatestObservations += 1;
      return [];
    },
  });
  const read = async (slug: string) => {
    accesses.read += 1;
    return readLatestCorridorRate(slug, { repository });
  };
  return { repository, read, accesses };
}
