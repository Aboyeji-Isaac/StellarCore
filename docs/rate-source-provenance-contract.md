# Normalized Rate-Source Provenance Field Contract

## Overview

Issue #113 requires every persisted rate snapshot to be traceable to the reviewed
source configuration, capture run, and remote endpoint that produced it. The goal
is an auditable chain from a normalized observation back to a known anchor/corridor
candidate and configuration revision without exposing secrets, credentials, or raw
remote payloads.

This document defines the normative contract for normalized rate-source provenance
fields, their types, required vs. optional status, redaction rules, and migration
semantics, consistent with #113 and issues #331–#332.

---

## Normalized Provenance Fields

The normalized provenance record captures deterministic, non-secret metadata
sufficient to reproduce how a rate observation candidate was selected and executed:

| Field | Type | Status | Description & Rules |
| :--- | :--- | :--- | :--- |
| `sourceType` | `"sep38"` | **Required** | The explicit protocol/kind of the rate source. Currently fixed to `"sep38"`. |
| `anchorSlug` | `string` | **Required** | Canonical lowercase kebab-case slug of the reviewed anchor (e.g. `"zeam"`). Max 120 characters. |
| `corridorSlug` | `string` | **Required** | Canonical lowercase kebab-case slug of the reviewed corridor (e.g. `"usdc-us-brl-br"`). Max 120 characters. |
| `endpointUrl` | `string` | **Required** | The sanitized, normalized HTTP/HTTPS endpoint URL queried during the capture run. Must not contain user credentials, tokens, or query secrets. |
| `configurationDigest` | `string` | **Required** | Deterministic 64-character lowercase hexadecimal SHA-256 digest of the canonicalized, non-secret rate-source configuration fields (as defined in #331). |
| `requestShapeVersion` | `string` | **Required** | Identifier of the request contract/shape version used (e.g. `"v1"`, max 64 characters alphanumeric plus `_.-`). |
| `capturedAt` | `string` | **Required** | ISO 8601 UTC timestamp string representing when the rate was observed at the source boundary. |
| `captureRunId` | `string` | **Optional** | Unique identifier linking the observation to its durable capture/refresh run (e.g. UUID or timestamped run ID, max 128 characters). Null or omitted for standalone/unbound observations. |

---

## Secret Exclusion and Redaction Rules

Under no circumstances may credentials, tokens, or secret-bearing URLs enter
persisted provenance or audit logs:

1. **Explicit Key Blacklist:**
   The following field names (case-insensitive, normalized across hyphens and underscores)
   are prohibited anywhere in provenance payloads:
   - `password`, `passwd`
   - `secret`, `client_secret`
   - `token`, `access_token`, `refresh_token`
   - `auth`, `authorization`, `bearer`
   - `api_key`, `apikey`
   - `private_key`, `signing_key`, `key`
   - `cookie`, `session`, `session_token`
   - `credential`, `credentials`

2. **Credential-Bearing URL Rejection:**
   URLs containing embedded userinfo (`https://user:pass@host/path`) or sensitive query parameters
   (`?token=...`, `?key=...`, `?secret=...`, `?auth=...`, etc.) are rejected with error code
   `CREDENTIAL_BEARING_URL` and must not pass through to storage.

3. **Pattern Matching:**
   Values matching Bearer tokens (`Bearer <token>`), JSON Web Tokens (`eyJ...`), or database/service
   connection strings are detected and rejected under `PROHIBITED_SENSITIVE_FIELD`.

4. **Failure Behavior & Error Safety:**
   Validation failures are deterministic. Error codes and error messages must never echo, log,
   or interpolate the rejected secret value.

---

## Truth and Evidence Constraints

1. **Observed at Capture Time:**
   Provenance records must reflect what was actually used and observed at the moment of capture.
   They must never be retrofitted, guessed, or reconstructed from current registry constants
   and presented as historical facts.

2. **Missing Legacy Lineage:**
   Historical rate snapshots predating provenance tracking must be explicitly recorded and queried
   as `unavailable` or `unknown`. Imputing or fabricating legacy provenance is strictly forbidden.

3. **Failed and Skipped Observations:**
   Failed or skipped rate candidates (e.g. timeout, invalid quote, quote rejection) must be recorded
   only in bounded run-level summaries and never persisted as successful rate snapshot rows.

4. **Public Read Path Independence:**
   Internal provenance and lineage data must never trigger live remote network fetches during
   read operations. Persisted evidence remains the immutable source of truth.
