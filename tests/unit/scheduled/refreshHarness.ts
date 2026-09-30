import {
  REFRESH_PHASES,
  assertLegalPhaseTransition,
  assertLegalRunTransition,
  resolveTerminalRunState,
  sanitizeRefreshFailures,
  type RefreshPhaseName,
  type RefreshPhaseStateValue,
} from "@/lib/scheduled/refreshRunState";
import type {
  RefreshLockOutcome,
  RefreshLockProvider,
} from "@/lib/scheduled/refreshLock";
import type {
  CompleteRefreshRunInput,
  CreateRefreshRunInput,
  RefreshPhaseProgress,
  RefreshRunRecord,
  RefreshRunStore,
  SetRefreshPhaseInput,
} from "@/lib/scheduled/refreshRunRepository";

/**
 * Faithful in-memory stand-in for the Prisma-backed ledger. It enforces the
 * same transition and terminal-state rules so orchestrator tests exercise the
 * real state machine without a database. PostgreSQL-specific behavior is
 * covered by the env-gated database integration test.
 */
export function createInMemoryRefreshRunStore(): Readonly<{
  store: RefreshRunStore;
  rows: () => readonly RefreshRunRecord[];
}> {
  const rows = new Map<string, RefreshRunRecord>();

  const store: RefreshRunStore = Object.freeze({
    create: async (input: CreateRefreshRunInput) => {
      const phases = initialPhases(input.initialPhases);
      const record: RefreshRunRecord = Object.freeze({
        id: input.id,
        triggeredBy: input.triggeredBy,
        state: "RUNNING",
        attempt: input.attempt,
        resumedFromId: input.resumedFromId ?? null,
        startedAt: input.startedAt.toISOString(),
        completedAt: null,
        phases: Object.freeze(phases),
        failures: Object.freeze([]),
        result: null,
      });
      rows.set(record.id, record);
      return record;
    },
    get: async (id) => rows.get(id) ?? null,
    findActive: async () => {
      const running = [...rows.values()]
        .filter((row) => row.state === "RUNNING")
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      return running[0] ?? null;
    },
    listRecent: async (limit) => Object.freeze(
      [...rows.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, Math.max(1, Math.min(100, Math.floor(limit)))),
    ),
    setPhase: async (runId: string, phase: RefreshPhaseName, input: SetRefreshPhaseInput) => {
      const current = requireRow(rows, runId);
      if (current.state !== "RUNNING") {
        throw new Error(`Cannot update phase ${phase} on run ${runId} in terminal state ${current.state}.`);
      }
      assertLegalPhaseTransition(current.phases[phase].state, input.state);
      const progress: RefreshPhaseProgress = Object.freeze({
        state: input.state,
        startedAt: input.startedAt === undefined
          ? current.phases[phase].startedAt
          : input.startedAt?.toISOString() ?? null,
        completedAt: input.completedAt === undefined
          ? current.phases[phase].completedAt
          : input.completedAt?.toISOString() ?? null,
        summary: input.summary === undefined ? current.phases[phase].summary : input.summary,
      });
      const updated: RefreshRunRecord = Object.freeze({
        ...current,
        phases: Object.freeze({ ...current.phases, [phase]: progress }),
      });
      rows.set(runId, updated);
      return updated;
    },
    complete: async (runId: string, input: CompleteRefreshRunInput) => {
      const current = requireRow(rows, runId);
      assertLegalRunTransition(current.state, input.state);
      const expected = resolveTerminalRunState({
        rates: current.phases.rates.state,
        reputation: current.phases.reputation.state,
      });
      if (input.state !== expected) {
        throw new Error(`Terminal state ${input.state} does not match phases (expected ${expected}).`);
      }
      const updated: RefreshRunRecord = Object.freeze({
        ...current,
        state: input.state,
        completedAt: input.completedAt.toISOString(),
        failures: sanitizeRefreshFailures(input.failures),
        result: input.result,
      });
      rows.set(runId, updated);
      return updated;
    },
    markInterrupted: async (runId, input) => {
      const current = requireRow(rows, runId);
      assertLegalRunTransition(current.state, "FAILED");
      const updated: RefreshRunRecord = Object.freeze({
        ...current,
        state: "FAILED",
        completedAt: input.completedAt.toISOString(),
        failures: sanitizeRefreshFailures([
          ...current.failures,
          { phase: "ORCHESTRATION", code: input.code },
        ]),
      });
      rows.set(runId, updated);
      return updated;
    },
  });

  return Object.freeze({ store, rows: () => Object.freeze([...rows.values()]) });
}

export function createFakeLockProvider(
  outcome: "acquired" | "unavailable" = "acquired",
): Readonly<{
  provider: RefreshLockProvider;
  state: { acquires: number; releases: number };
}> {
  const state = { acquires: 0, releases: 0 };
  const provider: RefreshLockProvider = Object.freeze({
    acquire: async (): Promise<RefreshLockOutcome> => {
      state.acquires += 1;
      if (outcome === "unavailable") {
        return Object.freeze({ acquired: false as const });
      }
      return Object.freeze({
        acquired: true as const,
        lease: Object.freeze({
          release: async () => {
            state.releases += 1;
          },
        }),
      });
    },
  });
  return Object.freeze({ provider, state });
}

function initialPhases(
  carried?: Readonly<Partial<Record<RefreshPhaseName, RefreshPhaseProgress>>> | undefined,
): Record<RefreshPhaseName, RefreshPhaseProgress> {
  const phases = {} as Record<RefreshPhaseName, RefreshPhaseProgress>;
  for (const phase of REFRESH_PHASES) {
    phases[phase] = { state: "PENDING", startedAt: null, completedAt: null, summary: null };
  }
  if (carried) {
    for (const phase of REFRESH_PHASES) {
      const progress = carried[phase];
      if (progress?.state === "SUCCEEDED") phases[phase] = progress;
    }
  }
  return phases;
}

function requireRow(
  rows: Map<string, RefreshRunRecord>,
  runId: string,
): RefreshRunRecord {
  const row = rows.get(runId);
  if (row === undefined) throw new Error(`Refresh run ${runId} was not found.`);
  return row;
}

export type { RefreshPhaseStateValue };
