# Reputation evaluation history

Each completed persisted evaluation creates one immutable row in
`reputation_evaluations`. The row records the score state, component inputs and
results, bounded evidence counts, explanatory metrics, computation time, and
the explicit scoring policy version. It contains summaries only, never raw
quotes, transfer payloads, or reconstructed observations.

`reputation_scores` remains the one-row-per-anchor current projection used by
the public API. In one transaction the repository appends the evaluation,
selects the current evaluation by `computed_at DESC, id DESC`, and advances the
projection. Equal timestamps therefore have a stable UUID tie-break. If any
step fails, neither history nor the projection advances. Public requests still
read only the projection and never recalculate reputation.

## Policy versions

New evaluations use `reputation-v1`. Any change to weights, thresholds,
minimum evidence, component definitions, or metric interpretation requires a
new immutable version string and tests proving its meaning. Old rows are never
recalculated or relabeled with a newer version.

The migration copies every pre-existing projection to a `legacy-unknown`
evaluation. It preserves score, band, state, metrics, sample size, and time.
Component values and detailed evidence counts that were not previously stored
remain `NULL`; they are not inferred. Insufficient evidence remains distinct
from score zero.

## Immutability and operations

The application repository exposes insertion and bounded history reads only.
PostgreSQL triggers reject updates and deletes even through direct Prisma calls.
An exceptional correction requires a separately reviewed migration that
records the affected evaluation IDs and operator/reason in the deployment audit
log before temporarily replacing the trigger. Routine cleanup, recomputation,
and current-projection repair are not reasons to mutate history.

Rollback should restore the database backup taken before migration. Dropping
the evaluation table would destroy audit evidence and is not a normal rollback.
