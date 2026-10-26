# Normalized Rate-Source Provenance Field Contract

## Overview

Issue #113 requires persisted rate snapshots to be traceable to the reviewed source configuration, capture run, and remote endpoint that produced them. This establishes an auditable chain from a normalized rate observation to a known anchor/corridor candidate and configuration revision without exposing credentials, tokens, authorization material, or raw remote payloads.

This document defines the normative contract for provenance fields, validation, secret exclusion, evidence integrity, and migration semantics, consistent with issue #113 and issues #331–#332.

## Normalized Provenance Fields

The normalized provenance record captures deterministic, non-secret metadata sufficient to identify the source configuration and execution context used to obtain a rate observation.

| Field | Type | Status | Description and constraints |
|---|---|---|---|
| `sourceType` | `"sep38"` | Required | Explicit source protocol type. Only `"sep38"` is currently supported. |
| `anchorSlug` | `string` | Required | Canonical lowercase kebab-case identifier of the registered anchor. Maximum 120 characters. |
| `corridorSlug` | `string` | Required | Canonical lowercase kebab-case identifier of the registered corridor. Maximum 120 characters. |
| `endpointUrl` | `string` | Required | Normalized HTTP/HTTPS source endpoint used during capture. Must not contain embedded credentials or sensitive query parameters. |
| `configurationDigest` | `string` | Required | 64-character lowercase hexadecimal SHA-256 digest of the canonicalized, non-secret source configuration, as defined in issue #331. |
| `requestShapeVersion` | `string` | Required | Identifier of the request contract or shape version, such as `"v1"`. Maximum 64 characters; permitted characters are alphanumeric, underscore, period, and hyphen. |
| `capturedAt` | `string` | Required | ISO 8601 UTC timestamp representing when the observation was captured at the source boundary. |
| `captureRunId` | `string` | Optional | Identifier linking the observation to its durable capture or refresh run. Maximum 128 characters. May be null or omitted for standalone or unbound observations. |

The normalized record must contain only the fields permitted by this contract. Unknown or prohibited fields must not be silently persisted.

## Secret Exclusion and Redaction Rules

Credentials, tokens, authorization material, and secret-bearing URLs must never enter persisted provenance or audit logs.

### 1. Prohibited field names

Field names are checked case-insensitively, with hyphens and underscores normalized. The following names and sensitive variants are prohibited anywhere in provenance payloads:

- **Credentials:** `password`, `passwd`, `credential`, `credentials`
- **Secrets:** `secret`, `client_secret`
- **Tokens:** `token`, `access_token`, `refresh_token`, `session_token`
- **Authorization material:** `auth`, `authorization`, `bearer`
- **API keys:** `api_key`, `apikey`, `key`
- **Cryptographic material:** `private_key`, `signing_key`
- **Session material:** `cookie`, `session`

Matching must account for normalized field names and sensitive variants without incorrectly rejecting unrelated safe field names merely because they contain a prohibited substring.

### 2. Credential-bearing URL rejection

URLs containing embedded user information, such as `https://user:pass@host/path`, or sensitive query parameters, such as `token`, `key`, `secret`, or `auth`, must be rejected with `CREDENTIAL_BEARING_URL`.

Sensitive URL values must not be persisted, logged, or included in validation errors. Redaction must not be used as a substitute for rejection when the contract requires the original URL to be rejected.

### 3. Sensitive value detection

Validation must reject recognized sensitive values, including:

- Bearer authorization tokens.
- JSON Web Tokens (JWTs).
- Database or service connection strings containing credentials.
- Other recognized credential-bearing values prohibited by the provenance contract.

These violations must produce a deterministic structured error, such as `PROHIBITED_SENSITIVE_FIELD`, without exposing the rejected value.

### 4. Deterministic and safe failures

Validation must fail deterministically for invalid, secret-bearing, or credentialed inputs.

Error codes and messages must never echo, interpolate, or otherwise reveal secret values. Exceptions and audit logs must follow the same restriction.

## Truth and Evidence Constraints

### 1. Provenance reflects capture-time evidence

Provenance must describe what was actually used and observed during capture. Historical records must not be retrofitted, guessed, or reconstructed from current registry constants and represented as historical facts.

The configuration digest must be derived deterministically from the canonicalized, non-secret configuration fields. Secret values must not be included in the persisted provenance record or exposed through its digest-generation inputs or diagnostics.

### 2. Legacy records

Historical rate snapshots created before provenance tracking must retain their original status. Missing provenance must be represented as unavailable, unknown, or explicitly unlinked, as appropriate to the existing data model.

Legacy provenance must never be fabricated, guessed, or inferred from current configuration.

### 3. Failed and skipped observations

Failed or skipped rate candidates, including timeouts, invalid quotes, and rejected quotes, must be recorded only in bounded run-level summaries where appropriate. They must never be persisted as successful rate snapshot rows.

Run-level diagnostics must also exclude secrets and raw credential-bearing payloads.

### 4. Public read-path independence

Reading persisted rates or provenance must not trigger live remote network requests. Public read operations must rely on persisted evidence, preserving its integrity and preventing reads from changing or reconstructing historical lineage.

## Implementation Alignment

The implementation in `lib/rates/provenance.ts` and `types/provenance.ts` must enforce this contract consistently.

Validation, normalization, serialization, persistence, and error handling must agree on the permitted field set, required fields, optional `captureRunId`, URL rejection rules, sensitive-field detection, and deterministic failure behavior.

Tests must cover valid provenance, malformed fields, credential-bearing URLs, prohibited field names, sensitive values, error-message safety, optional run identifiers, and legacy records without provenance.
