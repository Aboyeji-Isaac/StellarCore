# Evidence Integrity Glossary

These terms describe how StellarCore qualifies the evidence it displays. They
refer to the current implementation and configuration, not to claims about an
anchor's legal, custodial, financial, or operational trustworthiness.

## Bootstrap phase

The protected, manual registry synchronization performed by
`npm run bootstrap:registry`. It reads the reviewed anchor and corridor
registries, fetches each anchor's SEP-1 `stellar.toml`, persists discovered
metadata, and synchronizes configured anchor-corridor associations. A
successful bootstrap establishes that the configured metadata was discovered
and persisted at that time; it does not execute transfers, verify settlement,
or infer new corridors from a TOML file.

## Corroboration

Independent fresh rate observations for the same corridor that can support a
median. `computeFreshMedian` includes only valid, non-zero observations whose
timestamps are not stale, future-dated, or invalid, and it returns a median
only when at least two such sources remain (`MIN_FRESH_SOURCES = 2`). Thus one
fresh source is an observation, not corroborated pricing evidence. Sources are
also expected to be independent reviewed anchor sources; duplicate candidates
for the same anchor and corridor are skipped by the rate engine.

## Insufficient evidence

The reputation state `insufficient_evidence`. It means the reputation engine
cannot publish a composite score because at least one required condition is
missing: 30 transfer outcomes in the trailing 90-day window, at least one
synchronized corridor, or at least one latest rate observation. The result
keeps `score` and `scoreBand` as `null`; missing component evidence scores zero
and weights are not redistributed. This state is distinct from an established
anchor with poor evidence quality, which can still receive a low score.

## Insufficient fresh sources

The rate result state `insufficient_fresh_sources`. It means fewer than two
fresh, valid, non-zero sources were available for the median at evaluation
time. The result has `median: null`, even if one source is fresh. Stale,
future-dated, invalid-timestamp, and invalid-rate observations are excluded
and retain an exclusion reason.

## Reviewed

An item admitted to StellarCore's source-controlled registry or candidate
configuration by the project maintainers. In particular, `REVIEWED_LIVE_RATE_SOURCES`
contains explicitly selected SEP-38 indicative-price candidates; the
configuration audit checks that each reviewed source references an existing
anchor and corridor, has configured anchor-corridor membership, is unique, and
matches the corridor's asset, country, amount, and context rules. “Reviewed” is
therefore provenance and configuration scope, not independent verification of
the returned rate or a guarantee that the anchor will complete a transfer.

## Score band

The categorical interpretation of an established 0-100 reputation score:

- `GREEN`: 95 through 100.
- `AMBER`: 80 through 94.
- `RED`: 0 through 79.

An unestablished result has no score band (`null`). The score is a weighted
combination of availability (20%), rate freshness (15%), corridor coverage
(15%), and transfer reliability (50%). Only `COMPLETED` transfer outcomes
count as successful for transfer reliability; the other modeled statuses do
not.

## Transfer-capable

The boolean derived from an anchor's advertised SEP numbers by
`transferCapable`. It is `true` when any advertised SEP is one of SEP-6,
SEP-24, or SEP-31, and `false` otherwise. The value is persisted as anchor
metadata after SEP-1 discovery. It indicates advertised transfer-related
capability, not that StellarCore can execute, authenticate, observe, or verify
a transfer.