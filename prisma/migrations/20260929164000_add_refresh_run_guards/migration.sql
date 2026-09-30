-- Enforce run-ledger invariants at the database boundary so an illegal
-- transition or malformed row fails loudly instead of silently corrupting
-- operator-visible recovery state. The application state machine in
-- lib/scheduled/refreshRunState.ts rejects the same transitions first;
-- these guards are defense in depth for out-of-band writes.
ALTER TABLE "refresh_runs"
  ADD CONSTRAINT "refresh_runs_attempt_check" CHECK ("attempt" >= 1),
  ADD CONSTRAINT "refresh_runs_triggered_by_check" CHECK (char_length("triggered_by") BETWEEN 1 AND 32),
  ADD CONSTRAINT "refresh_runs_completion_check" CHECK (("state" = 'running') = ("completed_at" IS NULL));
