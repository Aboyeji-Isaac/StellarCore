# Evidence Retention and Archival Lifecycle

## Expected Growth and Hot Data

StellarCore observes indicative rates and stores transfer outcomes for reputation evidence.
With continuous polling (e.g., every minute) across dozens of anchors and corridors, `RateSnapshot` can accumulate tens of millions of rows per year.
`TransferOutcome` scales with the actual transfer volume of integrated anchors and could reach millions of records per month.

### Hot Data Requirements
- **RateSnapshots:** The rate engine and reputation evaluation require the *latest* rate snapshot for each anchor/corridor pair. Historical rate snapshots are not currently queried for medians or fresh evaluations.
- **TransferOutcomes:** The reputation evaluation requires transfer outcomes from the trailing 90 days. Outcomes older than 90 days are ignored by the scoring algorithm.

## Retention Classes

### Hot
- **RateSnapshots:** The absolute latest snapshot for each `(anchor_id, corridor_id)` pair, plus any snapshot captured in the last 7 days.
- **TransferOutcomes:** All outcomes recorded in the last 90 days (plus a 7-day safety buffer, so 97 days total).

### Archived
Evidence moved out of primary tables to prevent unbounded growth of `rate_snapshots` and `transfer_outcomes`, improving index performance on hot queries.
- **ArchivedRateSnapshot:** Rate snapshots older than 7 days that are *not* the latest for their anchor/corridor.
- **ArchivedTransferOutcome:** Transfer outcomes older than 97 days.

### Immutable Retention
Archived tables are immutable append-only structures. No evidence is silently deleted. They preserve historical provenance for replay and auditability.

## Archival and Restore Strategy

1. **Archival (Safe Resumable Operation)**:
   The `archive-evidence` script identifies candidates for archival (e.g. older than 7 days for rates, 97 for outcomes).
   For rates, it strictly excludes the latest observation per anchor/corridor pair to ensure the latest-rate window and reputation score calculations remain correct.
   It copies rows to `ArchivedRateSnapshot` and `ArchivedTransferOutcome` within a transaction, and then deletes them from the primary tables. This operation is idempotent and can be re-run safely.

2. **Restore / Replay**:
   The `restore-evidence` script can move archived rows back to the hot tables, which may be needed if the reputation window is extended (e.g. moving from 90 to 180 days) or if historical median audits require them.

## Verification
- Latest-rate results remain unchanged across archival boundaries because the latest snapshot is always preserved.
- Reputation scores remain unchanged because outcomes within the 90-day window are never archived.
