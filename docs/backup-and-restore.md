# Backup and Restore

## Restore Drill

The repository includes an isolated PostgreSQL restore drill. It accepts a
PostgreSQL custom-format archive (`pg_dump --format=custom`) and its creation
time. It never accepts a destination URL: the only restore destinations are
uniquely named disposable PostgreSQL 16 containers, each on a dedicated Docker
network and a random port published to `127.0.0.1`. The drill generates a
random password, never prints connection details, and removes its containers,
networks, and temporary files on success or failure.

Run the CI-safe self-test locally:

```sh
npm run restore:drill -- --self-test
```

The self-test applies the checked-in migrations to an isolated fixture database,
inserts representative registry, rate, outcome, and reputation evidence,
creates a temporary custom-format dump, restores it into a second isolated
database, and confirms a truncated archive is rejected. It requires Docker and
the repository's installed Node dependencies. GitHub Actions runs this test
daily and on manual dispatch; it does not access a production database or
upload a backup.

Run a drill against a backup using its trusted creation timestamp:

```sh
npm run restore:drill -- \
  --backup /secure/path/stellarcore.dump \
  --backup-created-at 2026-09-30T08:00:00Z
```

The default recovery objectives are a 15-minute RTO and a 24-hour RPO. Override
them only for a documented exercise:

```sh
npm run restore:drill -- \
  --backup /secure/path/stellarcore.dump \
  --backup-created-at 2026-09-30T08:00:00Z \
  --rto-seconds 900 --rpo-seconds 86400
```

RTO is elapsed drill time; RPO is the age of the backup at drill start. Keep
backup files and creation timestamps in the approved secret-management or
backup-provider workflow. Do not place backups in the repository or pass
production connection strings to the drill. Run it from a trusted host where
Docker is available and authorized to access the backup file.

The machine-readable JSON summary reports the archive SHA-256, applied
migration count, schema compatibility, row counts and SHA-256 checksums of
deterministically ordered samples (up to 100 rows per table), relationship
integrity, API read status, duration, objective results, and cleanup status. It
does not include row contents, connection strings, passwords, or raw database
errors. A failed restore, migration check, schema comparison, relationship
check, evidence read, objective, or cleanup returns a non-zero exit status and a
stable error code.

## Restore Procedure

1. Retrieve the backup and its creation timestamp through the approved backup
   provider. Verify provider-side retention and access controls before copying
   it to the trusted drill host.
2. Run the restore drill command above. Do not restore into a configured
   application database; the drill has no destination option.
3. Retain the JSON result with the operational exercise record. Treat the
   archive SHA-256 and evidence sample checksums as verification metadata, not
   as backup credentials.
4. On failure, use only the stable error code to triage. The drill suppresses
   database and Docker stderr to keep credentials and data out of logs. Confirm
   cleanup status before retrying; do not remove unrelated containers or
   networks.

The drill validates backup readability, migration state, Prisma schema
compatibility, required foreign keys, orphan relationships, registry/rate/
reputation evidence counts and checksums, and representative production
repository/API read paths. It does not replace provider retention monitoring,
off-site backup protection, or a provider-level point-in-time recovery test.