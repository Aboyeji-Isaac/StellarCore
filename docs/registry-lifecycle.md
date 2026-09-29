# Reviewed registry lifecycle

The database distinguishes current reviewed coverage from historical evidence.
`registry_active = true` means the entity or association is present in the last
complete, successfully validated reviewed registry. `false` means it was absent
from that registry; `registry_retired_at` records when this was observed and
`registry_retirement_reason` is the bounded value
`removed_from_reviewed_registry`. Retirement is not a reachability result.

The bootstrap command validates the complete anchor, corridor, and association
registries before opening its reconciliation transaction. It then activates new
rows, updates reviewed metadata, retires missing rows, and reactivates returning
slugs or associations. Rows are updated in place, so IDs, rate snapshots,
transfer outcomes, reputation evidence, and their original timestamps remain
unchanged. A thrown write rolls back the whole reconciliation. Discovery runs
after reconciliation and can update operational status without retiring rows.

Public directory and detail repositories expose active entities only. Their
relationship lists and counts include only active associations whose opposite
entity is also active. A retired slug therefore returns the same public result
as an unknown slug, while internal/database audit paths retain the row and all
linked history.

Use `npm run bootstrap:registry -- --dry-run` for a deterministic, sanitized
lifecycle summary without writes. Use PR #95's `npm run registry:diff` before
review to inspect source changes; reconciliation intentionally does not duplicate
that command.

## Deployment and rollback

Apply the lifecycle migration before deploying code that filters on these
columns. Existing rows are initialized active because they represent the
previous reviewed registry. Run the dry-run, review the sorted identifiers, then
run the applied bootstrap. If validation or reconciliation fails, stop: never
substitute a partial registry or manually delete evidence. Application rollback
is safe while the columns remain. A schema rollback may drop the three named
check constraints, indexes, and lifecycle columns, but it loses lifecycle audit
state and must only follow a reviewed backup/restore plan; it never requires
deleting evidence tables.
