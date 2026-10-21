# Rate-Source Provenance Field Contract

Issue #113 requires rate observations to be traceable back to their capture run,
reviewed configuration revision, and source endpoint without storing credentials,
tokens, authorization headers, or sensitive query parameters.

This document describes the permitted provenance field contract and validation
rules implemented in `lib/rates/provenance.ts` and `types/provenance.ts`.

## Normalized Provenance Fields

| Field | Type | Required? | Meaning / Constraints |
| :--- | :--- | :--- | :--- |
| `sourceType` | `"sep38"` | Yes | Explicit source protocol type. Only `"sep38"` is currently supported. |
| `anchorSlug` | `string` | Yes | Lowercase kebab-case identifier of the registered anchor (max 120 chars). |
| `corridorSlug` | `string` | Yes | Lowercase kebab-case identifier of the registered corridor (max 120 chars). |
| `endpointUrl` | `string` | Yes | Normalized HTTP/HTTPS endpoint URL without user/password or sensitive query parameters. |
| `configurationDigest` | `string` | Yes | 64-character lowercase SHA-256 hexadecimal string of the reviewed configuration. |
| `requestShapeVersion` | `string` | Yes | Request contract/shape identifier (e.g. `"v1"`, max 64 chars). |
| `capturedAt` | `string` | Yes | ISO 8601 timestamp string representing observation time. |
| `captureRunId` | `string` | No | Identifier of the durable refresh run producing the observation. |

## Prohibited & Redacted Fields

The following fields and patterns are strictly prohibited from entering provenance records:
- **Credentials & Tokens:** `password`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `apikey`, `private_key`, `signing_key`, `cookie`, `session`.
- **Authorization Material:** `authorization`, `auth`, `bearer`.
- **Sensitive URLs:** Any URL containing basic auth credentials (`scheme://user:pass@host`) or sensitive query parameters (`?token=...`, `?key=...`, `?secret=...`).
- **Raw Payloads:** Full remote JSON/text responses are never stored in provenance.

## Error Handling & Determinism

- When invalid, secret-bearing, or credentialed inputs are detected, validation deterministically fails with a structured error code (`CREDENTIAL_BEARING_URL`, `PROHIBITED_SENSITIVE_FIELD`, etc.).
- Under no circumstances will error messages, codes, or thrown exceptions echo the secret value.

## Legacy Records

Historical rate snapshots predating provenance capture do not have retrofitted or guessed provenance.
Missing legacy provenance is explicitly treated as unavailable / unlinked, preserving truth in data.
