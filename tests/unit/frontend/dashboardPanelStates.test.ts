import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RatePanelView } from "@/components/dashboard/RatePanel";
import { formatEvidenceTimestamp } from "@/components/ui/EvidenceTimestamp";
import { getRatesApiResult } from "@/lib/api/rates";
import { createFileStaleEvidenceStore, STALE_EVIDENCE_MAX_AGE_MS } from "@/lib/api/staleEvidence";
import type { LatestCorridorRate } from "@/types/latestRates";
import type { RatesApiResult } from "@/types/api/rates";

const CORRIDOR = "usdc-us-brl-br";
const START = new Date("2026-09-20T12:00:00.000Z");
const FIRST_SOURCE = "2026-09-20T11:59:00.000Z";
const RECOVERED_SOURCE = "2026-09-20T12:03:00.000Z";
const OUTAGE = Object.assign(new Error("database offline"), { code: "P1001" });

type Mode = "initial" | "outage" | "recovered" | "application-error";

function latestRate(
  median: string,
  capturedAt: string,
  evaluatedAt: Date,
  rate: string,
): LatestCorridorRate {
  const observation = Object.freeze({
    snapshotId: "snapshot-1",
    anchorSlug: "zeam",
    anchorName: "Zeam",
    rate,
    sourceAmount: "100",
    destinationAmount: "125",
    fee: "0",
    capturedAt,
    freshnessState: "fresh" as const,
    ageMs: 1_000,
    included: true,
  });
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    evaluatedAt: evaluatedAt.toISOString(),
    state: "healthy",
    median,
    totalIndependentSources: 2,
    freshSourceCount: 2,
    observations: Object.freeze([observation]),
    exclusions: Object.freeze([]),
  });
}

function render(result: RatesApiResult): string {
  return renderToStaticMarkup(createElement(RatePanelView, { result })).replace(
    /<!-- -->/g,
    "",
  );
}

function timestampMarkup(value: Date): string {
  const iso = value.toISOString();
  return `<time dateTime="${iso}">${formatEvidenceTimestamp(iso)}</time>`;
}

test("a panel keeps previously loaded evidence only as an explicitly stale response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-panel-states-"));
  const staleEvidenceStore = createFileStaleEvidenceStore(directory);
  let mode: Mode = "initial";

  const load = (now: Date) =>
    getRatesApiResult(CORRIDOR, {
      now: () => now,
      staleEvidenceStore,
      reportError: () => {},
      readLatestRate: async () => {
        if (mode === "outage") throw OUTAGE;
        if (mode === "application-error") throw new Error("unexpected serialization failure");
        return mode === "initial"
          ? latestRate("1.25", FIRST_SOURCE, now, "1.25")
          : latestRate("1.50", RECOVERED_SOURCE, now, "1.50");
      },
    });

  try {
    const initial = await load(START);
    assert.equal(initial.status, 200);
    if (initial.status !== 200) return;
    assert.equal(initial.degraded, undefined);
    const initialHtml = render(initial);
    assert.equal(initialHtml.includes('data-testid="rate-evidence-degraded"'), false);
    assert.match(initialHtml, /1\.25/);
    assert.match(initialHtml, /Latest observation captured /);

    mode = "outage";
    const outageAt = new Date(START.getTime() + 1_000);
    const stale = await load(outageAt);
    assert.equal(stale.status, 200, "a transient read failure retains verified evidence");
    if (stale.status !== 200) return;
    assert.equal(stale.degraded?.state, "stale");
    assert.equal(stale.degraded?.generatedAt, START.toISOString());
    assert.equal(stale.degraded?.snapshotAgeMs, 1_000);
    assert.equal(
      stale.body.evaluatedAt,
      START.toISOString(),
      "a stale response must keep its original evaluation time",
    );
    assert.equal(stale.body.medianRate, "1.25");

    const staleHtml = render(stale);
    assert.match(staleHtml, /data-testid="rate-evidence-degraded"/);
    assert.match(staleHtml, /role="status"/);
    assert.match(staleHtml, /Stale evidence — the latest read failed/);
    assert.ok(
      staleHtml.includes(`generated ${new Date(START).toLocaleString()}`),
      "the stale panel must name the snapshot generation time",
    );
    assert.ok(staleHtml.includes("1 second old"));
    assert.match(staleHtml, /It is not a fresh observation\./);
    assert.equal(
      staleHtml.includes(timestampMarkup(outageAt)),
      false,
      "a failed refresh must not publish a newer evaluation time",
    );
    assert.ok(staleHtml.includes(timestampMarkup(START)));
    assert.ok(staleHtml.includes(`Latest observation captured ${new Date(FIRST_SOURCE).toLocaleString()}`));

    mode = "recovered";
    const recoveredAt = new Date(START.getTime() + 2_000);
    const recovered = await load(recoveredAt);
    assert.equal(recovered.status, 200);
    if (recovered.status !== 200) return;
    assert.equal(recovered.degraded, undefined, "recovery clears the degraded marker");
    assert.equal(recovered.body.medianRate, "1.50");
    const recoveredHtml = render(recovered);
    assert.equal(recoveredHtml.includes('data-testid="rate-evidence-degraded"'), false);
    assert.equal(recoveredHtml.includes("Stale evidence"), false);
    assert.ok(recoveredHtml.includes(timestampMarkup(recoveredAt)));
    assert.ok(recoveredHtml.includes(`Latest observation captured ${new Date(RECOVERED_SOURCE).toLocaleString()}`));
    assert.match(recoveredHtml, /1\.50/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failure without retained evidence clears the panel instead of showing old data as fresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-panel-expiry-"));
  const staleEvidenceStore = createFileStaleEvidenceStore(directory);
  let mode: Mode = "initial";

  const load = (now: Date) =>
    getRatesApiResult(CORRIDOR, {
      now: () => now,
      staleEvidenceStore,
      reportError: () => {},
      readLatestRate: async () => {
        if (mode === "outage") throw OUTAGE;
        if (mode === "application-error") throw new Error("unexpected serialization failure");
        return latestRate("1.25", FIRST_SOURCE, now, "1.25");
      },
    });

  try {
    const initial = await load(START);
    assert.equal(initial.status, 200);

    mode = "outage";
    const expiredAt = new Date(START.getTime() + STALE_EVIDENCE_MAX_AGE_MS + 1_000);
    const expired = await load(expiredAt);
    assert.equal(expired.status, 500, "evidence older than the snapshot window must not be served");
    const expiredBody = expired.body as { error: { code: string; message: string } };
    assert.equal(expiredBody.error.code, "internal_error");
    const expiredHtml = render(expired);
    assert.match(expiredHtml, /role="alert"/);
    assert.ok(expiredHtml.includes(expiredBody.error.message));
    assert.equal(expiredHtml.includes('data-testid="rate-evidence-degraded"'), false);
    assert.equal(expiredHtml.includes("Median rate"), false);
    assert.equal(expiredHtml.includes("1.25"), false, "expired evidence must be cleared");

    mode = "application-error";
    const applied = await load(new Date(START.getTime() + 1_000));
    assert.equal(
      applied.status,
      500,
      "non-transient failures must not be replaced with retained evidence",
    );
    const appliedHtml = render(applied);
    assert.match(appliedHtml, /role="alert"/);
    assert.equal(appliedHtml.includes("Median rate"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale panel is replaced by a fresh healthy panel on the next successful read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-panel-recovery-"));
  const staleEvidenceStore = createFileStaleEvidenceStore(directory);
  let mode: Mode = "initial";

  const load = (now: Date) =>
    getRatesApiResult(CORRIDOR, {
      now: () => now,
      staleEvidenceStore,
      reportError: () => {},
      readLatestRate: async () => {
        if (mode === "outage") throw OUTAGE;
        return latestRate("1.25", FIRST_SOURCE, now, "1.25");
      },
    });

  try {
    assert.equal((await load(START)).status, 200);
    mode = "outage";
    const stale = await load(new Date(START.getTime() + 500));
    assert.equal(stale.status, 200);
    if (stale.status !== 200) return;
    assert.equal(stale.degraded?.state, "stale");

    mode = "initial";
    const recoveredAt = new Date(START.getTime() + STALE_EVIDENCE_MAX_AGE_MS - 1_000);
    const recovered = await load(recoveredAt);
    assert.equal(recovered.status, 200);
    if (recovered.status !== 200) return;
    assert.equal(recovered.degraded, undefined);
    const html = render(recovered);
    assert.equal(html.includes("Stale evidence"), false);
    assert.ok(html.includes(timestampMarkup(recoveredAt)));
    assert.match(html, /1\.25/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
