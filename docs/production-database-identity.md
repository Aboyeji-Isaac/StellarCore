# Production database identity

StellarCore's privileged production workflows — `prisma migrate deploy` and
`npm run bootstrap:registry` — both mutate the production database. A
misconfigured `DATABASE_URL` in the GitHub `production` environment would
otherwise be enough to point them at the wrong database, and a migration
applied to the wrong target is not something a rollback can undo cleanly.

This document describes the guard that prevents that, how to rotate the
production database deliberately, and what the guard deliberately does not
claim.

## The problem

A connection string is mutable text plus a credential. Validating the URL proves
only that someone wrote a well-formed URL; it says nothing about where the
connection lands. A pasted staging password, a wrong database name, a regional
replica, or a proxy that silently rewrites the database all produce a URL that
looks correct and connects successfully.

So the guard does not trust the URL. It connects, asks the server who it is, and
requires the answer to match a reviewed expectation.

## The identity model

Three independent facts must agree. Any one of them alone would be weak; all
three are required, and a mismatch in any of them halts.

### 1. Host, port, and database name

The parsed connection URL must name the reviewed host, port, and database. This
is the cheap check and the first thing to fail when a secret is pasted from the
wrong place.

### 2. Cluster fingerprint

The server's own reported identity is hashed:

```
sha256(
  "stellarcore-production-database/v1" +
  "\ndatabase=" + current_database() +
  "\nserver="   + inet_server_addr() + "/" + inet_server_port()
)
```

`inet_server_addr()` and `inet_server_port()` are what the *server* reports, not
what the URL claims. That is the property that defeats mutable URL text: the same
credential pointed at a different host yields a different fingerprint, so the
URL cannot be edited into agreement with an approved target.

The fingerprint is stable across PostgreSQL version upgrades and across a
failover promotion, because it depends only on the network identity and the
database name. It contains no credential and is safe to commit.

When `inet_server_addr()` is `NULL` — a Unix-domain socket, or an endpoint that
proxies without a real backend address — the fingerprint cannot be computed. That
is reported as `PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED` and halts. A direct,
non-pooled connection is required; this is the same requirement `docs/DEPLOYMENT.md`
already places on the migration credential.

### 3. Non-secret marker

A committed migration creates a one-row table:

```sql
production_database_identity(row_key text primary key, marker text not null, created_at timestamptz)
```

holding a public constant, `STELLARCORE_PRODUCTION_DATABASE_V1`. The preflight
reads the row and requires the marker to match the reviewed value. This catches
the case where a database is reachable at the right address but is not actually
this deployment's production database.

There is no code path that updates or deletes the row. Correcting it is a
reviewed, forward-only migration.

## Fail-closed behaviour

Every failure halts. There is no override flag, no `--force`, and no
"warn and continue" path. The preflight exits nonzero, which fails the workflow
job, which skips the mutation step.

| Code | Meaning |
| --- | --- |
| `PRODUCTION_DATABASE_URL_MISSING` | No connection string was provided. |
| `PRODUCTION_DATABASE_URL_INVALID` | The connection string is unparseable or has no host/database. |
| `PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED` | Not a `postgres://` or `postgresql://` URL. |
| `PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING` | No reviewed expectation is configured. |
| `PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID` | The approved fingerprint list is malformed, or an environment pin is not on it. |
| `PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID` | The reviewed marker is malformed, or an environment pin disagrees with it. |
| `PRODUCTION_DATABASE_HOST_MISMATCH` | The URL host is not the reviewed host. |
| `PRODUCTION_DATABASE_PORT_MISMATCH` | The URL port is not the reviewed port. |
| `PRODUCTION_DATABASE_NAME_MISMATCH` | The URL database name, or the server's `current_database()`, is not the reviewed name. |
| `PRODUCTION_DATABASE_FINGERPRINT_MISMATCH` | The server-reported identity is not on the approved fingerprint list. |
| `PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED` | The server did not expose a verifiable network address. |
| `PRODUCTION_DATABASE_MARKER_MISSING` | The target is provisioned but the marker row is absent, or it is unprovisioned and the registry does not allow provisioning. |
| `PRODUCTION_DATABASE_MARKER_MISMATCH` | The marker row carries a different value. |
| `PRODUCTION_DATABASE_READ_ONLY_REQUIRED` | The probe transaction was not read-only. |
| `PRODUCTION_DATABASE_TARGET_IN_RECOVERY` | The target is a read replica or standby. |
| `PRODUCTION_DATABASE_OBSERVATION_FAILED` | The probe could not connect or could not read. |

The result is also written as a single line of JSON with `action` set to
`continue` or `halt`, so a workflow log shows the decision explicitly rather than
only inferring it from an exit code.

## The guard is read-only

The probe opens a dedicated `pg` connection, not the shared Prisma client,
because it must also work before migrations have ever been applied to a freshly
provisioned database.

It issues exactly four statements:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT current_database(), current_setting('transaction_read_only'), ...;
SELECT to_regclass('public.production_database_identity') IS NOT NULL AS present;
SELECT marker FROM public.production_database_identity WHERE row_key = $1;
COMMIT;
```

`transaction_read_only` is read *inside* the probe transaction, so the read-only
guarantee is verified on the connection that produced the observation rather than
assumed. A server that cannot honour it halts. The row key is always a bound
parameter, and the relation name is a checked-in constant validated as a plain
identifier, so nothing executable can arrive through either.

## Diagnostics never contain secrets

The result type is built so that leaking a credential is not merely avoided but
unrepresentable:

- Every issue carries only a `code` and an optional `field` name. There is no
  free-text payload to carry a connection string.
- The username is dropped as well as the password. Managed PostgreSQL usernames
  are frequently random strings that are part of the secret, and omitting them
  costs nothing diagnostically.
- Driver and network errors collapse to a single
  `PRODUCTION_DATABASE_OBSERVATION_FAILED` code. A libpq error embeds the DSN,
  so the cause is counted and never forwarded.
- The fingerprint is a hash of non-secret facts and contains no credential.

The unit suite asserts each of these properties directly, including that a
driver error carrying the full connection string produces a result with no
trace of it.

## Where the expectation lives

The reviewed identity is a repository file, not a secret:

`constants/productionDatabaseIdentity.ts`

```ts
{
  id: "primary",
  host: "db.stellarcore.example",
  port: 5432,
  database: "stellarcore_prod",
  clusterFingerprints: ["sha256:…"],
  marker: { rowKey: "primary", value: "STELLARCORE_PRODUCTION_DATABASE_V1" },
  provisioningAllowed: false,
  reviewedNote: "…why this is the production target…",
}
```

`npm run audit:config` validates it offline, with no database, network, or
secrets, and `/constants/`, `/lib/config/`, and `/prisma/migrations/` are all
CODEOWNERS-gated, so an identity change requires maintainer review.

The repository currently ships an **unresolved placeholder**: the host uses the
reserved `.invalid` TLD, which by RFC 2606 can never resolve, and the approved
fingerprint is all zeros, which no SHA-256 preimage can produce. A pull request
cannot accidentally authorise a real target, and the preflight halts until a
maintainer replaces both through review.

### Optional non-secret environment pins

Two optional variables may narrow the expectation during a rotation window. They
can never widen it, so a wrong pin fails closed rather than opening a hole:

| Variable | Effect |
| --- | --- |
| `PRODUCTION_DATABASE_EXPECTED_FINGERPRINT` | Narrows the approved list to this one fingerprint. Rejected if it is not already on the reviewed list. |
| `PRODUCTION_DATABASE_EXPECTED_MARKER` | Requires this exact marker. Rejected if it disagrees with the reviewed marker. |

Neither is a credential, and neither is required.

## Provisioning a new production database

A brand-new target has no marker table yet, so the marker check has nothing to
read. That state is allowed only while `provisioningAllowed` is `true` on the
reviewed entry, which makes the bootstrap allowance a visible property of the
review rather than a runtime override. Host, name, and fingerprint stay fully
enforced, so the allowance can only ever admit the reviewed target before it has
been migrated — never a different database.

1. Provision the PostgreSQL instance and database.
2. Obtain its cluster fingerprint by running the preflight against it and reading
   the `fingerprint` field of the halted result. The fingerprint is not a secret
   and can be pasted into a pull request.
3. Open a pull request that sets `host`, `database`, `clusterFingerprints`, and
   `provisioningAllowed: true` in `constants/productionDatabaseIdentity.ts`, with
   a `reviewedNote` explaining the provisioning.
4. Wait for `npm run audit:config` to pass on the pull request.
5. Merge, then update the `production` environment's `DATABASE_URL` secret.
6. Run **Deploy production migrations**. The preflight reports
   `provisioned: false` and continues; the migration creates the marker table.
7. Open a follow-up pull request setting `provisioningAllowed: false`, and
   re-run the migration workflow. The preflight now enforces the marker.

## Rotating the production database

Rotation is the same path with an overlap window, and it is a reviewed identity
update rather than an environment edit.

1. Provision the replacement and read its fingerprint as above.
2. Open a pull request that lists **both** the outgoing and incoming fingerprints
   in `clusterFingerprints`, and points `host`/`database` at the replacement. The
   list is deliberately a list so a window in which both are approved is an
   explicit, visible decision. `reviewedNote` should say which is which and when
   the old target is decommissioned.
3. Merge, then update the `production` environment's `DATABASE_URL` secret.
4. Run **Deploy production migrations** against the new target. Optionally set
   `PRODUCTION_DATABASE_EXPECTED_FINGERPRINT` to the incoming fingerprint for
   the duration of the window, so a silent change to either cluster halts.
5. Run **Bootstrap production registry** against the new target.
6. Deploy the application and verify the read APIs
   (`GET /api/anchors`, `/api/corridors`, `/api/rates`, `/api/reputation`).
7. Decommission the old target, then open a pull request removing its
   fingerprint so only the current target is approved.

The old database's marker row is never edited. Rotation replaces the target and
re-provisions; it does not rewrite history on either side.

## What this guard does not claim

- **It is not a substitute for least privilege.** A credential with write access
  to the wrong database still has write access; the guard only ensures no
  privileged workflow uses it against an unapproved target.
- **It does not protect against an attacker who can edit the repository.** The
  expectation is a reviewed file. Protecting the review itself is what CODEOWNERS
  and branch protection are for.
- **It does not detect a compromised production database.** If the target itself
  is malicious, the fingerprint it reports is the one the guard reads. The marker
  is a claim about provenance, not a proof of integrity.
- **It does not replace backups or migration rollback.** See
  `docs/backup-and-restore.md` and the rollback section of
  `docs/DEPLOYMENT.md`.
- **It does not govern the read-only application runtime or the cron refresh.**
  Those are read paths outside this mutation boundary; the preview policy in
  `docs/DEPLOYMENT.md` governs them instead.

## Related

- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — deployment procedure, environment
  setup, and the workflow sections that run the preflight.
- [`docs/backup-and-restore.md`](backup-and-restore.md) — restore procedure for
  the production database.
- [`docs/testing-guide.md`](testing-guide.md) — how the unit and integration
  suites cover the guard.
