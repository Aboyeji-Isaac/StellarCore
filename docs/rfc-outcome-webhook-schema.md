# RFC: Transfer-outcome webhook payload schema

- **Status:** Proposed for maintainer decision
- **Date:** 2026-09-26
- **Scope:** Payload schema design only; no endpoint, model, migration, middleware, or ingestion code is proposed here

## Summary

This RFC defines the JSON payload contract a future transfer-outcome webhook would receive from an authorized anchor. It separates what the webhook **would receive** from what StellarCore **would verify** and what StellarCore **would later store or use**.

This document deliberately proposes **no** endpoint, **no** `TransferOutcome` model change, **no** database migration, **no** authentication middleware, **no** replay store, and **no** application ingestion code. It exists so that the payload format, trust model, and rejection policy can be reviewed before any writer is introduced.

The proposal is consistent with the existing architecture:

- Public APIs stay read-only; a webhook is a private, server-side intake boundary, never a public write endpoint.
- `TransferOutcome` remains the normalized downstream projection of accepted evidence, not the evidence record itself.
- The reputation engine ([`lib/reputation/score.ts`](../lib/reputation/score.ts)) keeps using `recordedAt`, the `TransferStatus` enum, `fillRate`, `settlementMs`, and `slippage`; the webhook supplies the facts that projection needs.

## Current state and constraints

StellarCore already persists `TransferOutcome` rows with:

| Field | Type | Meaning |
|---|---|---|
| `anchorId` | UUID | Relation to `Anchor` |
| `corridorId` | UUID | Relation to `Corridor` |
| `status` | enum | `COMPLETED`, `PARTIAL`, `REFUNDED`, `EXPIRED`, `ERROR` |
| `fillRate` | Float | Fraction of the requested source amount that was filled, `0..1` |
| `settlementMs` | Int | Time to reach the terminal state, in milliseconds |
| `slippage` | Float | Difference between quoted and achieved rate, in the corridor's destination-currency fraction |
| `recordedAt` | DateTime(tz) | Time the outcome was recorded |

The current model stores **no** source identifier, source event identifier, source-native status, evidence reference, signature, reviewer, verification state, ingestion timestamp, or source-level deduplication key. The existing RFC ([`rfc-outcome-ingestion-architecture.md`](rfc-outcome-ingestion-architecture.md)) already concluded that the normalized table "should be treated as a downstream projection of accepted evidence, not as the evidence record itself."

The webhook payload proposed here is therefore the **wire contract at the intake boundary** — the raw statement an anchor sends — not a proposal to reshape the `TransferOutcome` schema. If this contract is approved, a separate implementation RFC would decide which accepted fields project into `TransferOutcome` and how provenance is persisted.

## Concrete payload schema

The proposed payload is a single signed JSON object. All numeric and timestamp fields use the units and formats below.

```json
{
  "schemaVersion": "1",
  "event": {
    "id": "txn_9f3c2a1b7d4e5f6a8b9c0d1e",
    "version": 1,
    "occurredAt": "2026-09-25T14:32:07.184Z"
  },
  "source": {
    "anchorSlug": "zeam",
    "corridorSlug": "usdc-us-brl-br"
  },
  "outcome": {
    "status": "COMPLETED",
    "statusDetail": "funds transferred to destination account",
    "fillRate": "1.000000",
    "settlementMs": 214500,
    "slippage": "0.000012",
    "settledAt": "2026-09-25T14:35:41.684Z"
  },
  "amounts": {
    "requested": {
      "sourceAmount": "1250.00",
      "sourceAsset": "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "destinationAmount": "7025.50",
      "destinationAsset": "iso4217:BRL"
    },
    "filled": {
      "sourceAmount": "1250.00",
      "destinationAmount": "7025.50"
    }
  },
  "createdAt": "2026-09-25T14:36:02.915Z",
  "provenance": {
    "keyId": "anchor-signing-key-2026-01",
    "algorithm": "Ed25519",
    "signature": "base64url-encoded-signature-over-canonical-payload"
  }
}
```

### Field reference

#### Top level

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | string (`"1"`) | required | Version of this payload contract. Must be checked before parsing anything else. |
| `event` | object | required | Stable identity of the underlying transfer event. See below. |
| `source` | object | required | Who is reporting and for which reviewed relationship. See below. |
| `outcome` | object | required | The terminal result and the derived numeric facts StellarCore's reputation engine consumes. See below. |
| `amounts` | object | optional | Amount and asset context. Optional because some statuses (`EXPIRED`, `ERROR`) may carry no filled amount. |
| `createdAt` | string (RFC 3339 UTC) | required | Time the anchor produced this payload (ingest/report time). Distinct from `event.occurredAt` and `outcome.settledAt`. |
| `provenance` | object | required | Signature and key metadata for verification. See [Provenance strategy](#provenance-strategy). |

#### `event`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, 1–200 chars, anchor-assigned | required | **Stable, source-scoped, unique transfer event identifier.** This is the deduplication key: `source.anchorSlug + event.id` must identify one logical transfer for the life of StellarCore's retention. It must not change across retries or corrections. |
| `version` | integer `>= 1` | required | Version of this logical event. A correction or retraction is a new `version` of the same `event.id`, not a new `event.id` (see [Replay and corrections](#event-identity-replay-and-corrections)). |
| `occurredAt` | string (RFC 3339 UTC) | required | When the transfer reached (or would reach) its terminal state from the anchor's perspective. This is the event-time the reputation window should be anchored to, not `createdAt`. |

#### `source`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `anchorSlug` | string | required | The anchor being reported on. Must match a slug in StellarCore's reviewed anchor registry; the payload's signature must verify under the key registered for **this** slug. |
| `corridorSlug` | string | required | The corridor of the transfer. Must match a `Corridor.slug` in StellarCore's reviewed corridor registry and must be a corridor associated with the anchor. |

#### `outcome`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | string enum | required | `COMPLETED`, `PARTIAL`, `REFUNDED`, `EXPIRED`, or `ERROR`. See [Status semantics](#status-semantics). |
| `statusDetail` | string, 1–500 chars | optional | Human-readable source-native detail. Stored/displayed only if an implementation RFC accepts it; never used by scoring. |
| `fillRate` | string decimal, `0 <= x <= 1`, up to 6 fractional digits | required when `status` is `COMPLETED` or `PARTIAL` | Fraction of requested source amount filled. Transmitted as a string to preserve precision; the ingestion layer converts to the `Float` persisted today. |
| `settlementMs` | integer `>= 0`, milliseconds | required when a terminal settlement happened | Wall-clock duration from transfer initiation to terminal state, as reported by the anchor. Units are **milliseconds** (matches the existing `settlementMs Int` column). |
| `slippage` | string decimal (may be negative), up to 12 fractional digits | required when the transfer carried a quote | Difference between quoted and achieved rate in destination-asset fraction (matches the existing `slippage Float` semantics). Transmitted as a string; negative values are valid (improved rate). |
| `settledAt` | string (RFC 3339 UTC) | optional when `COMPLETED` or `PARTIAL` on an off-chain leg | When the off-chain settlement leg reached its terminal state. This is the best available proxy for "when did settlement actually finish" and may differ from `event.occurredAt`. |

#### `amounts`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requested.sourceAmount` | string decimal, > 0 | optional | Source amount requested, in `sourceAsset` units. |
| `requested.sourceAsset` | string (SEP asset identifier) | optional | Source asset (for example `stellar:USDC:...` or `iso4217:BRL`). |
| `requested.destinationAmount` | string decimal, > 0 | optional | Destination amount requested, in `destinationAsset` units. |
| `requested.destinationAsset` | string (SEP asset identifier) | optional | Destination asset. |
| `filled.sourceAmount` | string decimal `>= 0` | optional | Source amount actually filled. |
| `filled.destinationAmount` | string decimal `>= 0` | optional | Destination amount actually filled. |

`requested.sourceAsset` and `requested.destinationAsset` are required together; a partial amount block with one asset missing is malformed.

## Constants and enums

### `schemaVersion`

Single allowed value today: `"1"`. Future additive changes bump the version and must be documented; breaking changes are a new version, never silent reuse of `"1"`.

### `outcome.status`

| Value | Meaning (StellarCore semantics) |
|---|---|
| `COMPLETED` | The full source-defined transfer reached a successful terminal state. Under current scoring this is the only success. |
| `PARTIAL` | The transfer settled but not at the requested fill. Under current scoring this is a failure. |
| `REFUNDED` | The transfer was reversed after partial or full collection. A scoring failure. |
| `EXPIRED` | The transfer lapsed (for example a quote or payout window expired). A scoring failure. |
| `ERROR` | The transfer failed. A scoring failure. |

These map 1:1 to the persisted `TransferStatus` enum. A future implementation RFC may additionally persist the source-native status string alongside the normalized `status`; the webhook contract does not require a separate source-native status field because `statusDetail` is optional and the enum already expresses the terminality the scoring engine binds to.

### Units and formats

- **Timestamps:** RFC 3339 with `Z` (UTC), millisecond precision. No offsets are accepted as a substitute for UTC; the ingestion layer rejects absent `Z`.
- **Numeric amounts and rates:** strings (JSON has no decimal type). Rules:
  - Plain decimal notation only — no exponent (`1e3`), no signs on amounts (except `slippage`), no trailing-whitespace.
  - `fillRate`: `0 <= x <= 1`, at most 6 fractional digits.
  - `slippage`: at most 12 fractional digits, sign allowed.
  - `sourceAmount`/`destinationAmount`: `> 0` for requested, `>= 0` for filled.
- **`settlementMs`:** integer milliseconds `>= 0`.

## What StellarCore would verify

On receipt, the ingestion boundary would run, in order:

1. **Schema version check** — reject before parsing anything else if `schemaVersion` is unsupported.
2. **Signature verification** — against the key registered for the claimed `source.anchorSlug`, over the canonical serialization (below).
3. **Identity binding** — `source.anchorSlug` must be a reviewed anchor; `source.corridorSlug` must be a reviewed corridor associated with that anchor.
4. **Event identity and replay** — `event.id` + `event.version` must not have been accepted already, and `event.occurredAt` must respect the freshness window.
5. **Value validation** — units, formats, enum membership, and intra-payload consistency (`fillRate` compatible with `amounts.filled/requested` when both are present; `settledAt >= event.occurredAt`).
6. **Optional cross-check** — where a reviewed correlation rule exists, Horizon may corroborate the on-chain leg. This is corroboration only and never converts a failed off-chain leg into `COMPLETED`.

### Canonical payload serialization

For signature verification the payload is serialized canonically so byte-for-byte equality is deterministic:

- UTF-8; object keys sorted lexicographically by Unicode code point; no insignificant whitespace; no duplicate keys; arrays in received order.
- Numeric strings stay strings; RFC 3339 timestamps are normalized to millisecond form with `Z`.
- The `provenance.signature` and `provenance.keyId` fields are **excluded** from the bytes that are signed.

The serving anchor and StellarCore agree on this canonical form out of band as part of onboarding; it is not discovered at request time.

## Provenance strategy

### Preferred approach: anchor-signed payloads with a registered public key

- Each qualifying anchor holds an **outcome-signing key pair distinct from its SEP-1 `SIGNING_KEY`**, or a formally authorized dedicated subkey. The SEP-1 `SIGNING_KEY` is documented for SEP-10 authentication and is not reused for outcome attestation without explicit maintainer approval (consistent with the ingestion-architecture RFC).
- The anchor's public key, `keyId`, signing algorithm (proposal: Ed25519), activation and expiry dates, and revocation state are **registered in StellarCore's reviewed anchor registry**. Key discovery is therefore a controlled onboarding step, not a runtime `stellar.toml` fetch. The registry is the trust root; a signature verifying against an unregistered key is rejected.
- The anchor signs the canonical payload (see above). StellarCore verifies the signature with the registered key before any other processing.
- Replay protection combines three controls:
  - `event.id` scoped to the anchor is the stable deduplication key;
  - `event.version` makes corrections explicit rather than ambiguous new events;
  - a durable accepted-event store rejects repeated `(anchorSlug, eventId, version)` tuples and events whose `event.occurredAt` falls outside the accepted freshness window (for example older than a configured maximum backfill depth).

### Alternatives

- **Mutual TLS or shared-secret authentication** over the transport can establish *who is calling* but proves nothing about statement integrity, survives neither key rotation nor replay without the event store, and is weaker for long-term auditability. It may be used additionally, never instead of a signature.
- **SEP-10 session authentication** establishes a scoped participant session; it is not durable outcome provenance.
- **Manual review** remains the required fallback for anchors without signing support: an authorized reviewer submits or approves an evidence bundle with an audit trail, per the existing ingestion-architecture RFC. Payloads from non-signing anchors are never accepted through the automated signed path.

The webhook contract is **proposed future design**: none of this signing trust root, key registry, canonicalizer, or replay store exists today. This RFC does not pretend otherwise.

## Rejection and failure handling

Every failed payload produces a structured intake result: a rejection reason code, the offending event identity when recoverable, and an optional human-read snippet. The policy is:

1. **Reject and log** — invalid signature, unknown or revoked `keyId`, unknown anchor, mismatched anchor/key binding, unsupported `schemaVersion`, malformed JSON, malformed values, impossible values (`settledAt` before `occurredAt`, `fillRate > 1`, negative amounts), or invalid corridor association.
2. **Reject as duplicate** — a replayed `event.id` + `event.version` (including a replayed *older* version of an already accepted event). The payload is ignored after logging; it is never queued.
3. **Reject as stale** — an event whose `occurredAt` is outside the accepted freshness window (unless an explicitly documented backfill window is approved for that source).
4. **Queue for manual review** — only three cases:
   - signature verifies but the key is in a **suspension** state (revocation in progress);
   - `event.id` collides with an accepted event but carries a **higher** `event.version` that arrives before the correction supersession rule ran, so a human decides supersession;
   - the source reported a status that the source-native mapping does not yet understand.
5. **Ignore after logging only** — events for corridors or anchors outside the reviewed registries, and events older than the freshness window, are dropped without affecting reputation.

Nothing accepted into the queue may reach `TransferOutcome` or the reputation calculation until a reviewer accepts it. The policy deliberately avoids silently counting borderline payloads as evidence: rejections never inflate or deflate any scoring denominator.

## Event identity, replay, and corrections

- `event.id` is opaque to StellarCore but must be **anchor-stable**: identical across retries of the same webhook delivery, changed only when the logical transfer changes.
- A **correction** is a new `event.version` for the same `event.id`; it supersedes prior versions without deleting them.
- A **retraction** is a special correction that marks the event void; if normalization already projected the original into `TransferOutcome`, retraction leads to a reviewed supersession, never a silent `DELETE`.
- **Backfills** are re-deliveries of accepted `(event.id, event.version)` tuples or explicit new events inside an approved window; both are deduplicated by the accepted-event store.
- **Batches** are outside this payload contract. If batch delivery is later needed, a separate batch envelope that cryptographically binds every included event is required; this RFC defines only the single-event envelope.

## Reuse of existing models and terminology

- The `status` enum maps exactly to the persisted `TransferStatus` enum (`COMPLETED`, `PARTIAL`, `REFUNDED`, `EXPIRED`, `ERROR`) in [`prisma/schema.prisma`](../prisma/schema.prisma).
- `fillRate`, `settlementMs`, `slippage`, and `recordedAt` naming matches the `TransferOutcome` columns and the reputation engine's expectations ([`lib/reputation/score.ts`](../lib/reputation/score.ts), [`lib/reputation/repository.ts`](../lib/reputation/repository.ts)).
- `recordedAt` in the database corresponds to the projected value of the payload's `event.occurredAt` — the reputation window ([`MIN_REPUTATION_OUTCOMES`](../constants/reputation.ts), 7/30/90-day metrics) is anchored to terminal event time, not to the time StellarCore ingested the payload.
- Terminology (`source assertion`, `attestation`, `provenance`, `terminal outcome`, `on-chain observation`, `off-chain settlement/transfer leg`, `review decision`, `source event identity`) is carried over verbatim from [`rfc-outcome-ingestion-architecture.md`](rfc-outcome-ingestion-architecture.md).

## Explicit non-goals

This RFC explicitly does **not** propose or authorize:

- a webhook HTTP endpoint, route, or handler;
- any change to the `TransferOutcome` model or `prisma/schema.prisma`;
- any database migration;
- authentication middleware or secret storage;
- an accepted-event/replay store implementation;
- a key registry implementation;
- a canonicalizer implementation;
- any ingestion or reputation-engine code;
- any change to public API behavior.

All of those require a separate, later implementation RFC with maintainer approval.

## Open maintainer decisions

1. Should the initial pilot use signed single-event payloads only, or is a minimal batch envelope required from the start?
2. What is the maximum allowed age (`occurredAt` freshness) before payloads are rejected as stale?
3. Should `statusDetail` and `amounts` be persisted at all, or dropped after validation to minimize stored customer data?
4. Which anchor, if any, should be the first onboarding candidate for the signing trust root?
5. Should `slippage` be clamped at a configured absolute bound before acceptance?

## Conclusion

The wire contract in this RFC gives an authorized anchoring partner a precise, versioned, self-describing JSON envelope while keeping every verification, replay, and rejection decision explicit and server-side. Nothing in this document writes data or changes the product. If maintainers approve the schema, the next step is an implementation RFC that separately proposes the intake endpoint, provenance persistence, and the accepted-event store, and only then any projection into the existing `TransferOutcome` model and reputation calculations.

## Repository references

- [`prisma/schema.prisma`](../prisma/schema.prisma) — current `TransferOutcome` and `TransferStatus` model
- [`lib/reputation/score.ts`](../lib/reputation/score.ts) — status, window, threshold, and metric semantics (`recordedAt`, `settlementMs`, `slippage`, `fillRate` usage)
- [`lib/reputation/repository.ts`](../lib/reputation/repository.ts) — current outcome read projection
- [`docs/rfc-outcome-ingestion-architecture.md`](rfc-outcome-ingestion-architecture.md) — trust architecture, terminology, and pilot plan this schema depends on
- [`README.md`](../README.md) — architectural invariants and public API boundaries