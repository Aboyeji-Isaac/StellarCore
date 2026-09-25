# Reputation Methodology

This document describes the reputation scoring implementation as it actually
exists in source. The authoritative files are:

- `constants/reputation.ts` — thresholds, weights, bands
- `lib/reputation/score.ts` — `calculateReputation`
- `lib/reputation/engine.ts` — orchestration / evidence read
- `types/reputation.ts` — types
- `lib/api/reputation.ts` — the public serialization (`serializeReputation`)

> Older documentation (e.g. README "33/33/33 weights", green/amber/red bands,
> or any assumed threshold) is **not** authoritative and is contradicted by the
> implementation below.

## 1. Constant values (from `constants/reputation.ts`)

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| `REPUTATION_OUTCOME_WINDOW_DAYS` | `90` | transfer outcomes older than 90 days are not counted as evidence |
| `REPUTATION_METRICS_WINDOW_DAYS` | `30` | settlement/slippage metrics use a 30-day window |
| `MIN_REPUTATION_OUTCOMES` | `30` | minimum in-window outcomes for a score to exist |
| `REPUTATION_WEIGHTS.availability` | `20` | |
| `REPUTATION_WEIGHTS.rateFreshness` | `15` | |
| `REPUTATION_WEIGHTS.coverage` | `15` | |
| `REPUTATION_WEIGHTS.transferReliability` | `50` | |
| `REPUTATION_BANDS.greenMinimum` | `95` | score `>= 95` ⇒ GREEN |
| `REPUTATION_BANDS.amberMinimum` | `80` | score `>= 80` ⇒ AMBER, else RED |

Weights sum to exactly 100. All constants are `Object.freeze`d; mutating them
at runtime is impossible in the shipped build.

## 2. Evidence model (`ReputationEvidence`)

Inputs to `calculateReputation(evidence, evaluatedAt)`:

- `status` — anchor status: `LIVE` | `DEGRADED` | `DOWN` | `UNKNOWN`.
- `corridorSlugs` — the set of corridors the anchor serves (deduplicated
  internally via `new Set`).
- `latestRates` — one-or-more captured rates per corridor; only the **latest**
  per corridor is used (largest `capturedAt`, and only when the corridor is in
  `corridorSlugs`).
- `transferOutcomes` — transfer outcomes with `status`
  (`COMPLETED` | `PARTIAL` | `REFUNDED` | `EXPIRED` | `ERROR`),
  `settlementMs`, `slippage`, `recordedAt`.

Only outcomes with `recordedAt` at or before `evaluatedAt` count toward the
score; future-recorded outcomes are filtered out. The engine (`engine.ts`)
reads a 90-day window (`REPUTATION_OUTCOME_WINDOW_DAYS`) for this purpose.

## 3. The four components

Every component starts from a **basis-points** value in `0..10_000`
(`BASIS_POINTS = 10_000`), then:

```
component.score        = round(scoreBp / 100)                    # 0..100
component.earnedPoints = round(scoreBp * weight / 10_000)        # half-up
```

`roundDiv` implements **round-half-up** (away from zero on the `.5` case):
`roundDiv(n, d) = Number((n + d/2) / d)` using BigInt arithmetic.

### 3.1 Availability (weight 20)

Maps anchor `status`:

| Status | Basis points | Score |
| ------ | ------------ | ----- |
| `LIVE` | 10 000 | 100 |
| `DEGRADED` | 5 000 | 50 |
| `DOWN` / `UNKNOWN` | 0 | 0 |

### 3.2 Rate Freshness (weight 15)

```
rateFreshnessBp = ratioBasisPoints(freshRateCount, latestRateCount)
```

- `freshRateCount` = latest rates whose age is within `RATE_FRESHNESS_THRESHOLD_MS`
  (`120_000` ms, see `constants/rates.ts`). Freshness is inclusive:
  age `<= 120 000` is fresh.
- `ratioBasisPoints(n, d)` returns `0` when `d <= 0` **or** `n <= 0`, otherwise
  `round(n * 10_000 / d)`.

### 3.3 Coverage (weight 15)

```
coverageBp = ratioBasisPoints(freshRateCount, corridorSlugs.size)
```

Fresh rate count over the **number of corridors**, not over latest rates. An
anchor with 1 fresh rate for 1 corridor scores 100; 1 fresh rate for 2
corridors scores 50.

### 3.4 Transfer Reliability (weight 50)

```
reliabilityBp = ratioBasisPoints(completedOutcomeCount, outcomeCount)
```

Only `COMPLETED` counts as success; `PARTIAL`, `REFUNDED`, `EXPIRED`, and
`ERROR` all count as failures. With zero relevant outcomes this is `0`.

## 4. Composite score

```
established = (outcomeCount >= 30)
              AND (corridorSlugs.size > 0)
              AND (latestRateCount > 0)

score = round_half_up(
          (availabilityBp * 20
           + rateFreshnessBp * 15
           + coverageBp * 15
           + reliabilityBp * 50) / 10_000
        )   when established, else null
```

- **Range:** because every BP term is in `0..10_000` and weights sum to 100,
  the composite is an integer in `0..100` (inclusive) — verified by property
  tests against random evidence.
- Minimum `0`: `DOWN` + all-failed outcomes + stale rate.
- Maximum `100`: `LIVE` + all `COMPLETED` + fresh rates covering every corridor.

## 5. Score bands

```
scoreBand = "GREEN"  if score >= 95
          = "AMBER"  if score >= 80
          = "RED"    otherwise
```

Lower bounds are **inclusive**. Boundaries pinned by tests
(`tests/unit/reputation/scoreBandBoundaries.test.ts`,
`reputationProperties.test.ts`):

| Score | Band |
| ----- | ---- |
| 95 | GREEN |
| 94 | AMBER |
| 80 | AMBER |
| 79 | RED |

When no score exists, `scoreBand` is `null`.

## 6. Evidence and metrics output

`ReputationCalculation` exposes:

- `state`: `"established"` | `"insufficient_evidence"`.
- `score`: integer `0..100` or `null`.
- `scoreBand`: `"GREEN"` | `"AMBER"` | `"RED"` or `null`.
- `components`: each of the four with `{ weight, score, earnedPoints }`.
- `evidence`:
  - `corridorCount` — distinct corridors from `corridorSlugs`.
  - `latestRateCount` — latest rates after per-corridor selection **and**
    filtering to `corridorSlugs`.
  - `freshRateCount` — fresh subset of latest rates.
  - `outcomeCount` — in-window outcomes (recorded at/before `evaluatedAt`).
  - `completedOutcomeCount` — `COMPLETED` subset.
  - `minimumOutcomeCount` — always `30` (the constant).
- `metrics` (from `calculateMetrics`, all based on in-window outcomes):
  - `fillRate7d` / `fillRate30d` / `fillRate90d` — ratio of `COMPLETED` to total
    in each window (`recordedAt >= evaluatedAt - N days`), or `null` when the
    window has zero outcomes. The 90-day metric uses all counted outcomes.
  - `settleP50Ms`, `settleP95Ms`, `slippageP50`, `slippageP95` — **nearest-rank
    percentile** of `COMPLETED` outcomes in the **30-day** window
    (`settlementMs` / `slippage` respectively), or `null` when there are no
    completed outcomes in that window. Percentile index is
    `ceil((p/100) * n) - 1`, clamped to `0`.

Note the subtle null-producing conditions:

- `score` is `null` when evidence is insufficient (below threshold, no
  corridors, or no latest rates) — even if every ratio is perfect.
- Fill rates are `null` only for **empty** windows.
- Settlement/slippage percentiles are `null` only when the 30-day window has
  no `COMPLETED` outcomes.

## 7. Null behavior through the public API

`lib/api/reputation.ts#serializeReputation` maps the calculation to the public
shape and adds its own guards:

| Persisted state | Public `state` |
| --------------- | -------------- |
| (no score row) | `not_evaluated` |
| `INSUFFICIENT_DATA` | `insufficient_evidence` |
| `OK` | `established` |

Public rules:

- `score` becomes `null` unless it is finite and within `0..100`
  (`safeScore`).
- `scoreBand` is lowercased (`"green"`/`"amber"`/`"red"`) or `null`.
- `evidence` is `{ outcomeCount: sampleSize }` when a row is persisted, else
  `null` (whole object).
- `metrics` is a 7-field object of `number | null` when a row is persisted,
  else `null`.
- `computedAt` is an ISO-8601 string when a row is persisted, else `null`.

## 8. Orchestration (`lib/reputation/engine.ts`)

`evaluateAnchorReputation(anchorSlug, { repository, evaluatedAt, persist })`:

1. Rejects non-finite `evaluatedAt` with failure code
   `INVALID_EVALUATION_TIME` **before** any repository access.
2. Reads evidence (`readEvidence`) for the 90-day window; failure of that read
   is `EVIDENCE_READ_FAILURE`.
3. Unknown anchor ⇒ `ANCHOR_NOT_FOUND`.
4. `calculateReputation` runs, and when `persist` is true the score is upserted
   (`ReputationRepository.upsertScore`); persistence failure ⇒
   `PERSISTENCE_FAILURE`.

## 9. What is intentionally NOT part of scoring

- No extra manual "reputational" deductions, no liquidity inputs, no
  reviewer-overrides, no time-decay weighting on individual outcomes beyond
  the window filter.
- The `scoreBand` band cutoffs are the only thresholds; there are no
  green/amber/red "stripes" with different normalization.
- Both `rateFreshness` and `coverage` derive from the same `freshRateCount` —
  they are not independent data sources.

## 10. Verification

Pinned by these tests:

- `tests/unit/reputation/score.test.ts` — weights exact (20/15/15/50), half-up
  rounding, threshold 30, immutability, rolling metrics.
- `tests/unit/reputation/scoreBandBoundaries.test.ts` — cutoffs 95/80 and the
  exact boundary points (95 GREEN / 94 AMBER, 80 AMBER / 79 RED, 100, 0).
- `tests/unit/reputation/bounds.test.ts` — lower and upper bounds.
- `tests/unit/reputation/reputationProperties.test.ts` — property-based
  checks: score in `0..100` for random valid evidence, band consistency,
  below/at threshold, evidence bookkeeping.