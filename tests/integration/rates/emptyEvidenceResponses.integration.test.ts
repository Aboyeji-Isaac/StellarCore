/**
 * Capture behavior for no-content and empty-body upstream responses.
 *
 * An evidence source can legitimately answer with `204 No Content`, an empty
 * JSON body, or a parsed-but-empty payload. None of those is a successful rate
 * observation, and none may be confused with malformed data or persisted as a
 * zero-valued quote.
 *
 * These tests cover the classification contract at the SEP-38 boundary and the
 * capture contract above it, using mocked upstream responses and an isolated
 * in-memory persistence fixture:
 *
 * 1. Empty responses are classified by the source contract (`HTTP_FAILURE` for
 *    a non-200 reply, `INVALID_JSON` for an absent body, `INVALID_CONTENT_TYPE`
 *    when no JSON media type is declared, `INVALID_DATA` for a parsed empty
 *    payload).
 * 2. No observation is persisted from an empty body, and the repository is
 *    never asked to store one.
 * 3. An independent source still completes and is persisted in the same run.
 * 4. The run summary and scheduled status report the actual outcome, and an
 *    empty response is treated as a transient quote failure rather than a
 *    permanent suppression.
 *
 * The `/prices` advertisement check that precedes capture follows the same
 * source contract: an empty body there fails preparation instead of being read
 * as an advertised pair, and still stores no observation.
 *
 * Nothing here performs a network request or touches a database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEWED_LIVE_RATE_SOURCES,
  ZEAM_BRL_ASSET,
  ZEAM_USDC_ASSET,
} from "@/constants/liveRateSources";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
  type LiveRateSourceDependencies,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SuppressionRepository } from "@/lib/scheduled/suppressionRepository";
import {
  getSep38IndicativePrice,
  getSep38Prices,
  Sep38ClientError,
} from "@/lib/stellar/sep38";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { RateQuoteProvider, RateSnapshotRepository } from "@/types/rates";
import type { Sep38AssetIdentifier } from "@/types/sep38";

const USD = "iso4217:USD" as const;
const NOW = new Date("2026-09-02T00:00:00.000Z");
const EMPTY_HOST = "quote-empty.example";
const HEALTHY_HOST = "quote-healthy.example";

const EMPTY_SERVER = `https://${EMPTY_HOST}/sep38`;
const HEALTHY_SERVER = `https://${HEALTHY_HOST}/sep38`;

const QUOTE_REQUEST = Object.freeze({
  sellAsset: ZEAM_USDC_ASSET,
  buyAsset: ZEAM_BRL_ASSET,
  sellAmount: "100",
  context: "sep31" as const,
});

// ---------------------------------------------------------------------------
// Mocked upstream responses
// ---------------------------------------------------------------------------

/** Dispatches a mocked `Response` by the upstream hostname of the request. */
function upstreamFetcher(
  responseByHost: Readonly<Record<string, () => Response>>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const respond = responseByHost[url.hostname];
    if (!respond) throw new Error(`unexpected upstream host in test: ${url.hostname}`);
    return respond();
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function emptyJsonResponse(): Response {
  return new Response("", {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": "0",
    },
  });
}

function hasCode(code: string, status?: number): (error: unknown) => boolean {
  return (error) =>
    error instanceof Sep38ClientError
    && error.code === code
    && (status === undefined || error.status === status);
}

function healthyIndicativeQuote() {
  return {
    sell_asset: ZEAM_USDC_ASSET,
    buy_asset: USD,
    total_price: "1",
    price: "1",
    sell_amount: "100",
    buy_amount: "100",
    fee: { total: "0", asset: USD, details: [] },
  };
}

// ---------------------------------------------------------------------------
// 1. Classification at the SEP-38 source boundary
// ---------------------------------------------------------------------------

test("a 204 No Content response is classified as an HTTP failure, not an observation", async () => {
  await assert.rejects(
    getSep38IndicativePrice(EMPTY_SERVER, QUOTE_REQUEST, {
      fetcher: upstreamFetcher({
        [EMPTY_HOST]: () => new Response(null, { status: 204 }),
      }),
    }),
    hasCode("HTTP_FAILURE", 204),
  );
});

test("a 200 response with an empty JSON body is classified as invalid JSON", async () => {
  for (const body of ["", " \n\t "]) {
    await assert.rejects(
      getSep38IndicativePrice(EMPTY_SERVER, QUOTE_REQUEST, {
        fetcher: upstreamFetcher({
          [EMPTY_HOST]: () => new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.length),
            },
          }),
        }),
      }),
      hasCode("INVALID_JSON"),
      `a body of ${JSON.stringify(body)} must be classified as INVALID_JSON`,
    );
  }
});

test("an empty response without a JSON media type is classified as an invalid content type", async () => {
  for (const response of [
    () => new Response(null, { status: 200 }),
    () => new Response("", { status: 200, headers: { "content-type": "text/plain" } }),
  ]) {
    await assert.rejects(
      getSep38IndicativePrice(EMPTY_SERVER, QUOTE_REQUEST, {
        fetcher: upstreamFetcher({ [EMPTY_HOST]: response }),
      }),
      hasCode("INVALID_CONTENT_TYPE"),
    );
  }
});

test("a parsed but empty payload is invalid data, not a zero-valued quote", async () => {
  for (const body of ["null", "{}"]) {
    await assert.rejects(
      getSep38IndicativePrice(EMPTY_SERVER, QUOTE_REQUEST, {
        fetcher: upstreamFetcher({
          [EMPTY_HOST]: () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      }),
      hasCode("INVALID_DATA"),
      `a body of ${JSON.stringify(body)} must be classified as INVALID_DATA`,
    );
  }
});

// ---------------------------------------------------------------------------
// Capture workflow fixtures
// ---------------------------------------------------------------------------

const QUOTE_SERVER_BY_ANCHOR: Readonly<Record<string, string>> = Object.freeze({
  zeam: EMPTY_SERVER,
  moneygram: HEALTHY_SERVER,
});

const BUY_ASSET_BY_SERVER: Readonly<Record<string, Sep38AssetIdentifier>> = Object.freeze({
  [EMPTY_SERVER]: ZEAM_BRL_ASSET,
  [HEALTHY_SERVER]: USD,
});

/**
 * Configuration seam of the reviewed capture workflow: discovery and the
 * advertised-pair check are doubled, exactly where production reaches the
 * network. The source entries themselves mirror the reviewed registry shape.
 */
function liveSourceDependencies(): LiveRateSourceDependencies {
  return {
    discover: async (entry) => Object.freeze({
      ...entry,
      tomlUrl: `https://${entry.homeDomain}/.well-known/stellar.toml`,
      organizationName: entry.name,
      organizationUrl: `https://${entry.homeDomain}/`,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      seps: Object.freeze([1, 10, 24, 31, 38] as const),
      isTransferCapable: true,
      endpoints: Object.freeze({ anchorQuoteServer: QUOTE_SERVER_BY_ANCHOR[entry.slug]! }),
      assets: Object.freeze([]),
    }),
    prices: async (server, request) => Object.freeze({
      direction: "sell" as const,
      requestedAsset: request.sellAsset!,
      requestedAmount: request.sellAmount!,
      pairs: Object.freeze([
        Object.freeze({
          sellAsset: request.sellAsset!,
          buyAsset: BUY_ASSET_BY_SERVER[server]!,
          price: "0.18",
          decimals: 2,
        }),
      ]),
    }),
  };
}

function quoteProvider(
  responseByHost: Readonly<Record<string, () => Response>>,
): RateQuoteProvider {
  return (candidate) => fetchReviewedIndicativeRate(
    candidate,
    (server, request) => getSep38IndicativePrice(server, request, {
      fetcher: upstreamFetcher(responseByHost),
    }),
  );
}

type CapturedRow = Readonly<{
  anchorId: string;
  corridorId: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

/** Isolated persistence fixture: records exactly what the workflow would store. */
function memoryRepository(): Readonly<{
  repository: RateSnapshotRepository;
  rows: () => readonly CapturedRow[];
}> {
  const rows: CapturedRow[] = [];
  const repository: RateSnapshotRepository = Object.freeze({
    findAnchorBySlug: async (slug: string) => Object.freeze({ id: `anchor-${slug}` }),
    findCorridorBySlug: async (slug: string) => Object.freeze({ id: `corridor-${slug}` }),
    hasAssociation: async () => true,
    findProvenanceBySnapshotId: async () => null,
    createSnapshot: async (input) => {
      rows.push(Object.freeze({ ...input }));
      return Object.freeze({ id: `snapshot-${rows.length}`, ...input, provenanceUnavailable: false });
    },
  });

  return Object.freeze({ repository, rows: () => Object.freeze([...rows]) });
}

function recordingSuppressions(recorded: unknown[]): SuppressionRepository {
  return Object.freeze({
    listSuppressed: async () => Object.freeze([]),
    recordDeterministicFailure: async (input) => {
      recorded.push(input);
      return Object.freeze({
        anchorSlug: input.anchorSlug,
        corridorSlug: input.corridorSlug,
        state: "ACTIVE" as const,
        reason: input.reason,
        failureCode: input.failureCode,
        failurePhase: input.failurePhase,
        consecutiveFailures: 1,
        firstFailedAt: input.observedAt.toISOString(),
        lastFailedAt: input.observedAt.toISOString(),
        suppressedAt: null,
        reactivatedAt: null,
        reactivationReason: null,
      });
    },
    reactivate: async () => null,
  });
}

// ---------------------------------------------------------------------------
// 2-4. Capture workflow: no persistence, independent completion, real status
// ---------------------------------------------------------------------------

const TWO_SOURCE_CONFIGURATION: readonly ReviewedLiveRateSource[] = Object.freeze([
  Object.freeze({
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    sellAsset: ZEAM_USDC_ASSET,
    buyAsset: ZEAM_BRL_ASSET,
    sellAmount: "100",
    buyDeliveryMethod: "PIX",
    countryCode: "BR",
    context: "sep31",
  }),
  Object.freeze({
    anchorSlug: "moneygram",
    corridorSlug: "usdc-us-usd-us",
    sellAsset: ZEAM_USDC_ASSET,
    buyAsset: USD,
    sellAmount: "100",
    countryCode: "US",
    context: "sep31",
  }),
]);

test("an empty response from one configured source persists nothing while an independent source completes", async () => {
  const candidates = await buildReviewedLiveRateCandidates(
    TWO_SOURCE_CONFIGURATION,
    liveSourceDependencies(),
  );
  assert.equal(candidates.length, 2);

  const store = memoryRepository();
  const result = await runRateEngine(candidates, {
    quote: quoteProvider({
      [EMPTY_HOST]: emptyJsonResponse,
      [HEALTHY_HOST]: () => jsonResponse(healthyIndicativeQuote()),
    }),
    repository: store.repository,
    now: () => NOW,
    configurationFingerprint: "test-fingerprint",
  });

  assert.deepEqual(
    {
      attempted: result.totalAttempted,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
      persisted: result.snapshotsPersisted,
    },
    { attempted: 2, succeeded: 1, failed: 1, skipped: 0, persisted: 1 },
  );

  assert.deepEqual(result.failures, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    phase: "QUOTE",
    code: "QUOTE_FAILURE",
  }]);

  const rows = store.rows();
  assert.equal(rows.length, 1, "an empty body must never be persisted as an observation");
  assert.equal(rows[0]!.anchorId, "anchor-moneygram");
  assert.equal(rows[0]!.corridorId, "corridor-usdc-us-usd-us");
  assert.equal(rows[0]!.rate, "1");
  assert.equal(rows[0]!.sourceAmount, "100");
  assert.equal(rows[0]!.destinationAmount, "100");
  assert.equal(rows[0]!.capturedAt.getTime(), NOW.getTime());
  assert.equal(
    rows.some((row) => row.rate === "" || row.rate === "0"),
    false,
    "no placeholder or zero-valued row may be stored",
  );

  const summary = formatLiveRateRunSummary(result);
  assert.equal(summary.totalAttempted, 2);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.snapshotsPersisted, 1);
  assert.deepEqual(
    summary.snapshots.map((snapshot) => snapshot.anchorSlug),
    ["moneygram"],
  );

  const recorded: unknown[] = [];
  const scheduled = await runScheduledRefresh({
    snapshotRates: async () => summary,
    evaluateReputation: async ({ evaluatedAt }) => {
      assert.equal(
        evaluatedAt.getTime(),
        NOW.getTime(),
        "reputation must still evaluate at the run start timestamp",
      );
      return Object.freeze({ attempted: 2, succeeded: 2, failed: 0, failures: Object.freeze([]) });
    },
    suppressions: recordingSuppressions(recorded),
    now: () => NOW,
  });

  assert.equal(scheduled.ok, false, "run status must reflect the failed source");
  assert.deepEqual(
    {
      attempted: scheduled.rates.attempted,
      succeeded: scheduled.rates.succeeded,
      failed: scheduled.rates.failed,
      suppressed: scheduled.rates.suppressed,
    },
    { attempted: 2, succeeded: 1, failed: 1, suppressed: 0 },
  );
  assert.equal(
    scheduled.reputation.succeeded,
    2,
    "an independent reputation workflow still completes",
  );
  assert.deepEqual(
    recorded,
    [],
    "an empty upstream response is transient, not a permanent suppression",
  );
});

test("when the configured source answers 204 the capture run reports failure and stores nothing", async () => {
  const store = memoryRepository();

  const summary = await snapshotReviewedLiveRates({
    assertConfiguration: () => undefined,
    listSuppressed: async () => Object.freeze([]),
    buildCandidates: (sources) =>
      buildReviewedLiveRateCandidates(sources, liveSourceDependencies()),
    executeCandidates: async (candidates) => formatLiveRateRunSummary(
      await runRateEngine(candidates, {
        quote: quoteProvider({
          [EMPTY_HOST]: () => new Response(null, { status: 204 }),
        }),
        repository: store.repository,
        now: () => NOW,
        configurationFingerprint: "test-fingerprint",
      }),
    ),
  });

  assert.deepEqual(
    {
      candidates: summary.totalCandidates,
      attempted: summary.totalAttempted,
      succeeded: summary.succeeded,
      failed: summary.failed,
      persisted: summary.snapshotsPersisted,
      suppressed: summary.suppressed ?? 0,
    },
    { candidates: 1, attempted: 1, succeeded: 0, failed: 1, persisted: 0, suppressed: 0 },
  );
  assert.deepEqual(summary.failures, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    phase: "QUOTE",
    code: "QUOTE_FAILURE",
  }]);
  assert.deepEqual(summary.snapshots, []);
  assert.equal(store.rows().length, 0, "no observation may be stored from a 204 response");

  const scheduled = await runScheduledRefresh({
    snapshotRates: async () => summary,
    evaluateReputation: async () => Object.freeze({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      failures: Object.freeze([]),
    }),
    suppressions: recordingSuppressions([]),
    now: () => NOW,
  });

  assert.equal(scheduled.ok, false);
  assert.deepEqual(
    {
      attempted: scheduled.rates.attempted,
      succeeded: scheduled.rates.succeeded,
      failed: scheduled.rates.failed,
    },
    { attempted: 1, succeeded: 0, failed: 1 },
  );
  assert.equal(scheduled.reputation.succeeded, 1);
});

test("an empty /prices response fails preparation and stores no observation", async () => {
  const store = memoryRepository();
  const preparationDependencies: LiveRateSourceDependencies = {
    discover: liveSourceDependencies().discover,
    prices: (server, request) => getSep38Prices(server, request, {
      fetcher: upstreamFetcher({ [EMPTY_HOST]: emptyJsonResponse }),
    }),
  };

  await assert.rejects(
    buildReviewedLiveRateCandidates(REVIEWED_LIVE_RATE_SOURCES, preparationDependencies),
    hasCode("INVALID_JSON"),
    "the advertised-pair check must not read an empty body as an advertisement",
  );

  const scheduled = await runScheduledRefresh({
    snapshotRates: async () => {
      const candidates = await buildReviewedLiveRateCandidates(
        REVIEWED_LIVE_RATE_SOURCES,
        preparationDependencies,
      );
      return formatLiveRateRunSummary(await runRateEngine(candidates, {
        quote: quoteProvider({ [EMPTY_HOST]: emptyJsonResponse }),
        repository: store.repository,
        now: () => NOW,
        configurationFingerprint: "test-fingerprint",
      }));
    },
    evaluateReputation: async () => Object.freeze({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      failures: Object.freeze([]),
    }),
    suppressions: recordingSuppressions([]),
    now: () => NOW,
  });

  assert.equal(scheduled.ok, false);
  assert.deepEqual(
    {
      attempted: scheduled.rates.attempted,
      succeeded: scheduled.rates.succeeded,
      failed: scheduled.rates.failed,
      failures: scheduled.rates.failures,
    },
    {
      attempted: 0,
      succeeded: 0,
      failed: 1,
      failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
    },
  );
  assert.equal(store.rows().length, 0, "preparation failure must not persist an observation");
  assert.equal(scheduled.reputation.succeeded, 1, "reputation evaluation still completes");
});
