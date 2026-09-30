# Deterministic fuzz and property testing for SEP response parsing

Issue #141. The suites under `tests/fuzz/` feed generated, malformed, and
boundary inputs to the untrusted SEP-1 TOML parser (`lib/stellar/sep1.ts`) and
the SEP-38 JSON/decimal/asset parsers (`lib/stellar/sep38.ts`), asserting that
every failure is a bounded, typed parser error — never an uncaught process
failure, an accepted unsafe URL, or invalid normalized evidence.

## Determinism

Every run derives its inputs from fixed seeds, so a passing suite is exactly
reproducible locally and in CI:

- `tests/fuzz/sep1Fuzz.test.ts` — seeds `20260930` and `20261001`
- `tests/fuzz/sep38Fuzz.test.ts` — seeds `20260930` and `20261002`

A failure message prints the seed and the case index that produced it, e.g.:

```
fuzz case failed: seed=20260930 index=41 kind=oversized-string
```

## Reproducing a failing seed locally

```bash
# Re-run one file with the exact committed seeds (same inputs as CI):
npx tsx --test tests/fuzz/sep38Fuzz.test.ts

# Filter to one failing test name:
npx tsx --test --test-name-pattern="malformed JSON" tests/fuzz/sep38Fuzz.test.ts

# Reproduce a single generated case outside the suite: set the seed the
# failure printed and skip to its index.
FUZZ_SEED=20260930 FUZZ_ONLY_INDEX=41 npx tsx --test tests/fuzz/sep38Fuzz.test.ts
```

The generator (`tests/fuzz/deterministicRandom.ts`) is mulberry32-based and
uses only `Math.imul`/unsigned shifts, which are identical across Node 22.x
versions and platforms, so seeds do not drift between contributor machines
and CI.

## Regression corpus

When fuzzing finds a parser bug that must be prevented forever, minimize the
input and persist it:

1. Copy the minimal failing input into
   `tests/fuzz/fixtures/regressions/sep1/` or `.../sep38/` with a descriptive
   name (for example `duplicate-conflicting-asset.json`).
2. Add a focused `.test.ts` case that loads the fixture and asserts the
   bounded typed failure (or the corrected accepted-state invariant).
3. Reference the issue describing the discovered finding.
4. Never weaken parser validation to make a corpus case pass; fixtures encode
   the contract that malformed remote data must keep failing closed.

Fixtures are committed inputs, not generated at runtime, so the corpus grows
deliberately and reviews each addition.

## Invariants asserted

For both parsers, across all generated inputs:

- No exception escapes the parser boundary other than the typed
  `Sep1DiscoveryError` / `Sep38ClientError` failures.
- Accepted evidence satisfies the normalization invariants (bounded sizes,
  valid HTTPS endpoints, sorted/deduplicated normalized outputs, decimals
  that match the documented pattern).
- Response-size and timeout protections are preserved; generated inputs are
  themselves length-capped so the harness stays fast and bounded.

## CI

`tests/fuzz/*.test.ts` files end in `.test.ts`, so `npm test` (and therefore
the existing CI test job) executes them with the committed seeds. The suites
complete in well under a second each, keeping CI runtime bounded and
repeatable. No real anchors and no network calls are involved: fetchers are
always injected or parsing functions are invoked directly.
