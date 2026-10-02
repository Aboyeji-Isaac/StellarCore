# Evidence export packages

StellarCore evidence exports are portable, database-independent audit packages
for a bounded time range and optional anchor/corridor selection.

## Format version 1.0

A package contains exactly five files:

- `manifest.json`
- `registry.json`
- `rate-snapshots.ndjson`
- `transfer-outcomes.ndjson`
- `reputation-scores.ndjson`

`registry.json` is canonical JSON. Evidence members are newline-delimited JSON
so records can be written and verified incrementally without loading the full
history into memory. Production database reads are paged in fixed batches of
250 records.

Every evidence member has a SHA-256 digest, byte length, and record count in the
manifest. The package root SHA-256 covers both the canonical member descriptors
and provenance, including the requested selection. Modifying provenance or any
covered member therefore makes verification fail against the recorded root.

The manifest records the StellarCore version, schema version, export time,
exporter identity, bounded selection, and deployment/configuration identifiers
when those non-secret identifiers are available.

## Creating an export

```bash
npm run export:evidence -- \
  --start 2026-09-01T00:00:00Z \
  --end 2026-10-01T00:00:00Z \
  --output ./incident-export \
  --anchor moneygram \
  --corridor usdc-us-ngn-ng \
  --exported-by maintainer-name
```

`--anchor` and `--corridor` may be repeated. The time range is required and
must have a start strictly before its end.

## Offline verification

Verification reads only the package directory. It does not import the database
client or require production credentials:

```bash
npm run verify:export -- --package ./incident-export
npm run verify:export -- --package ./incident-export --json
```

Verification fails if a required member is missing, bytes/hash/record count do
not match, provenance no longer matches the package root, package data contains
secret-shaped operational credentials, or the schema is invalid.

## Secret handling

The export path selects an explicit allowlist of evidence columns. It never
serializes environment variables, connection strings, authentication headers,
cookies, private keys, or runtime secret configuration. A final recursive
safety guard rejects credential-bearing URLs, bearer/JWT material, and known
secret-key fields before each record is written.

## Version compatibility

Version `1.0` is the only currently supported package version. The offline
verifier fails closed with `UNSUPPORTED_VERSION` for any future or unknown
version rather than guessing at compatibility. A future format revision must
add an explicit verifier path or migration policy before packages of that
version are accepted.

The verifier checks cryptographic integrity, not authenticity of the original
exporting operator. Long-term authenticity should use a separately retained or
signed root hash when required by incident-response policy.
