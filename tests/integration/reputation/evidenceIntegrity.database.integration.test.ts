import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { EvidenceIntegrityEvent } from "@/lib/evidence/integrity";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_EVIDENCE_INTEGRITY_DATABASE_INTEGRATION === "1";

test("corrupt persisted evidence is contained per record across reads and evaluation", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { setEvidenceIntegritySink, MAX_REPORTED_INTEGRITY_ISSUES } =
    await import("@/lib/evidence/integrity");
  const { evaluateAnchorReputation } = await import("@/lib/reputation/engine");
  const { readLatestCorridorRate } = await import("@/lib/rates/latestRateReadModel");
  const { getReputationApiResult } = await import("@/lib/api/reputation");
  const { PRISMA_REPUTATION_API_REPOSITORY } = await import("@/lib/api/reputationRepository");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const badSlug = `bad-${suffix}`;
  const goodSlug = `good-${suffix}`;
  const corridorSlug = `corridor-${suffix}`;
  const events: EvidenceIntegrityEvent[] = [];
  const previousSink = setEvidenceIntegritySink((event) => events.push(event));
  const sql = (text: string) => db.$executeRawUnsafe(text);

  try {
    const anchors = new Map<string, string>();
    for (const slug of [badSlug, goodSlug]) {
      const anchor = await db.anchor.create({
        data: {
          slug,
          name: `Integrity ${slug}`,
          homeDomain: `${slug}.example.com`,
          tomlUrl: `https://${slug}.example.com/.well-known/stellar.toml`,
          status: "LIVE",
        },
        select: { id: true },
      });
      anchors.set(slug, anchor.id);
    }
    const corridor = await db.corridor.create({
      data: { slug: corridorSlug, assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "USD", countryTo: "US" },
      select: { id: true },
    });
    for (const id of anchors.values()) {
      await db.anchorCorridor.create({ data: { anchorId: id, corridorId: corridor.id } });
    }
    const bad = anchors.get(badSlug)!;
    const good = anchors.get(goodSlug)!;
    const snapshot = (anchorId: string, rate: string, capturedAt: string, amount = "1", fee = "0") =>
      sql(`INSERT INTO rate_snapshots (anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at)
           VALUES ('${anchorId}', '${corridor.id}', '${rate}', ${amount}, ${amount}, ${fee}, ${capturedAt})`);
    const outcome = (anchorId: string, ms: number, slippage: string, recordedAt: string) =>
      sql(`INSERT INTO transfer_outcomes (anchor_id, corridor_id, status, fill_rate, settlement_ms, slippage, recorded_at)
           VALUES ('${anchorId}', '${corridor.id}', 'COMPLETED', 1, ${ms}, '${slippage}', ${recordedAt})`);

    // Valid, fresh evidence for both anchors.
    for (const id of [bad, good]) {
      await snapshot(id, "1.5", "now() - interval '10 seconds'");
      for (let index = 0; index < 30; index += 1) {
        await outcome(id, 1_000, "0.01", `now() - interval '${index + 1} minutes'`);
      }
    }
    // Corruption below application validation, all classes, on the bad anchor.
    await snapshot(bad, "NaN", "now()");                             // INVALID_NUMBER, newest
    await snapshot(bad, "1.6", "'infinity'");                        // INVALID_TIMESTAMP, sorts newest
    await snapshot(bad, "0", "now() - interval '1 second'");         // OUT_OF_RANGE (zero rate)
    await snapshot(bad, "1.7", "now() - interval '2 seconds'", "1", "-1"); // OUT_OF_RANGE (negative fee)
    await outcome(bad, -5, "0.01", "now()");                         // OUT_OF_RANGE
    await outcome(bad, 1_000, "NaN", "now()");                       // INVALID_NUMBER
    await outcome(bad, 1_000, "Infinity", "now()");                  // INVALID_NUMBER
    await outcome(bad, 1_000, "0.01", "'infinity'");                 // INVALID_TIMESTAMP
    // Enough extra corruption to prove diagnostics stay bounded.
    for (let index = 0; index < MAX_REPORTED_INTEGRITY_ISSUES + 5; index += 1) {
      await outcome(bad, -1, "0", "now()");
    }

    // Take "now" from the database so the test does not depend on clock skew
    // between this process and PostgreSQL.
    const [{ now: evaluatedAt }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

    // Reputation evaluation: the corrupt anchor still evaluates from its valid
    // evidence only, and the clean anchor is identical in outcome count.
    const badResult = await evaluateAnchorReputation(badSlug, { evaluatedAt, persist: false });
    const goodResult = await evaluateAnchorReputation(goodSlug, { evaluatedAt, persist: false });
    assert.ok(badResult.ok && goodResult.ok);
    assert.equal(badResult.calculation.evidence.outcomeCount, 30);
    assert.equal(badResult.calculation.evidence.freshRateCount, 1);
    assert.equal(badResult.calculation.score, goodResult.calculation.score);
    assert.deepEqual(badResult.calculation.metrics, goodResult.calculation.metrics);

    const repEvents = events.filter(({ issues }) => issues.some(({ anchorSlug }) => anchorSlug === badSlug));
    assert.ok(repEvents.length > 0);
    const outcomeEvent = repEvents.find(({ issues }) => issues.some(({ source }) => source === "transfer_outcome"))!;
    assert.ok(outcomeEvent.issues.length <= MAX_REPORTED_INTEGRITY_ISSUES);
    assert.ok(outcomeEvent.total >= 4 + MAX_REPORTED_INTEGRITY_ISSUES + 5);
    const classes = new Set(repEvents.flatMap(({ issues }) => issues.map(({ class: c }) => c)));
    assert.deepEqual([...classes].sort(), ["INVALID_NUMBER", "INVALID_TIMESTAMP", "OUT_OF_RANGE"]);
    for (const issue of repEvents.flatMap(({ issues }) => issues)) {
      assert.equal(issue.anchorSlug, badSlug);
      assert.equal(issue.corridorSlug, corridorSlug);
      assert.match(issue.recordId!, /^[0-9a-f-]{36}$/);
    }
    assert.equal(/NaN|nfinity/.test(JSON.stringify(events)), false);

    // Public rate read: corrupt latest snapshots cannot shadow valid history or
    // leak "NaN"; both anchors are still listed.
    events.length = 0;
    const rates = await readLatestCorridorRate(corridorSlug, { evaluatedAt });
    assert.ok(rates.ok);
    assert.deepEqual(rates.observations.map(({ anchorSlug }) => anchorSlug).sort(), [badSlug, goodSlug].sort());
    assert.ok(rates.observations.every(({ rate }) => rate === "1.5"));
    assert.equal(rates.median, "1.5");
    assert.equal(JSON.stringify(rates).includes("NaN"), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.total, 4);

    // Public reputation list: an unusable persisted score does not fail the list.
    await sql(`INSERT INTO reputation_scores (anchor_id, computed_at, composite_score, state)
               VALUES ('${bad}', 'infinity', 99, 'ok')`);
    const list = await getReputationApiResult({ repository: PRISMA_REPUTATION_API_REPOSITORY });
    assert.equal(list.status, 200);
    if (list.status === 200) {
      const entry = list.body.reputation.find(({ anchor }) => anchor.slug === badSlug)!;
      assert.equal(entry.state, "not_evaluated");
      assert.equal(entry.score, null);
    }
  } finally {
    setEvidenceIntegritySink(previousSink);
    const slugs = `'${badSlug}', '${goodSlug}'`;
    await sql(`DELETE FROM reputation_scores WHERE anchor_id IN (SELECT id FROM anchors WHERE slug IN (${slugs}))`);
    await sql(`DELETE FROM transfer_outcomes WHERE anchor_id IN (SELECT id FROM anchors WHERE slug IN (${slugs}))`);
    await sql(`DELETE FROM rate_snapshots WHERE anchor_id IN (SELECT id FROM anchors WHERE slug IN (${slugs}))`);
    await sql(`DELETE FROM anchor_corridors WHERE anchor_id IN (SELECT id FROM anchors WHERE slug IN (${slugs}))`);
    await sql(`DELETE FROM anchors WHERE slug IN (${slugs})`);
    await sql(`DELETE FROM corridors WHERE slug = '${corridorSlug}'`);
    await db.$disconnect();
  }
});
