# Backup Encryption Policy

## Scope
Governs encryption-at-rest and in-transit for all database backups
containing evidence, and the key lifecycle (rotation, retention,
retirement) that keeps those backups restorable. Extends
`docs/backup-and-restore.md`; does not replace it.

## Required properties
- **At rest**: every backup file is encrypted before it leaves the
  producing process. Plaintext dumps are never written to persistent
  storage, only to an ephemeral path cleaned up immediately after
  encryption.
- **In transit**: backups are transferred over TLS to storage; the
  encryption above means transport security is defense-in-depth, not
  the only protection.
- **Algorithm**: <FILL IN once you confirm what's available in this
  repo's infra — e.g. age (X25519), GPG, or a cloud KMS envelope
  scheme. State it explicitly here once decided.>

## Key versioning
- Every encryption key in use has a non-secret **key version
  identifier** (e.g. `key-v3`), assigned when the key is introduced.
- Every backup's metadata sidecar records which key version encrypted
  it. The key material itself is never recorded anywhere in the
  repository, logs, or backup metadata — only the version label.

## Backup metadata contract
Each backup `<name>.sql.enc` is accompanied by `<name>.meta.json`:
```json
{
  "backup_name": "string",
  "created_at": "ISO-8601 timestamp",
  "key_version": "string, e.g. key-v3",
  "algorithm": "string, e.g. age-x25519",
  "encrypted": true
}
```
A backup without this file, or with `encrypted: false`, or an
unrecognized `key_version`/`algorithm`, **fails verification** — it is
never treated as restorable by drills or migration gates.

## Rotation rules
- Rotating introduces a new key version; the previous version remains
  **supported for restore** (not supported for new backups) for a
  documented overlap window of <FILL IN — e.g. "the longest backup
  retention period currently configured">.
- New backups always encrypt under the current key version.
- Restore drills (see #170) must successfully decrypt one backup from
  the current key version and one from each other supported version on
  every run.

## Retirement rules
- A key version may only move from "supported for restore" to
  "retired" via an explicit, reviewed configuration change — never
  automatically on a timer.
- Before retirement, every retained backup still referencing that key
  version must be either:
  1. re-encrypted under a supported key version, or
  2. explicitly exempted via a reviewed, documented exception recorded
     in this file's "Exceptions" section (with justification and an
     expiry date).
- CI fails if retirement would strand a non-exempted backup.

## Emergency recovery / key-loss behavior
- If a key is lost before retirement: <FILL IN — document the actual
  blast radius: which backups become permanently unrestorable, who
  must be notified, and whether any out-of-band recovery (e.g. a
  sealed offline copy, a KMS admin-recovery path) exists.>
- This section must give an honest answer even if the answer is "those
  backups are permanently lost" — do not imply a recovery path that
  doesn't actually exist in this repo's infra.

## Exceptions
<None yet. Document any reviewed retirement exception here with:
backup name, key version, justification, approver, expiry date.>