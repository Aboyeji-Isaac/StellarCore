import type { Prisma } from "@/app/generated/prisma/client";
import {
  REFRESH_PHASES,
  assertLegalPhaseTransition,
  assertLegalRunTransition,
  resolveTerminalRunState,
  sanitizeRefreshFailures,
  type RefreshPhaseName,
  type RefreshPhaseStateValue,
  type RefreshRunStateValue,
  type SanitizedRefreshFailure,
} from "@/lib/scheduled/refreshRunState";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type RefreshPhaseProgress = Readonly<{
  state: RefreshPhaseStateValue;
  startedAt: string | null;
  completedAt: string | null;
  summary: unknown;
}>;

export type RefreshRunRecord = Readonly<{
  id: string;
  triggeredBy: string;
  state: RefreshRunStateValue;
  attempt: number;
  resumedFromId: string | null;
  startedAt: string;
  completedAt: string | null;
  phases: Readonly<Record<RefreshPhaseName, RefreshPhaseProgress>>;
  failures: readonly SanitizedRefreshFailure[];
  result: ScheduledRefreshResult | null;
}>;

export type CreateRefreshRunInput = Readonly<{
  id: string;
  triggeredBy: string;
  attempt: number;
  resumedFromId?: string | null | undefined;
  startedAt: Date;
  /**
   * Phase progress copied from a prior run when resuming. Only phases that
   * already reached SUCCEEDED are carried so a resume never re-executes
   * completed work and never invents evidence for phases that did not finish.
   */
  initialPhases?: Readonly<Partial<Record<RefreshPhaseName, RefreshPhaseProgress>>> | undefined;
}>;

export type SetRefreshPhaseInput = Readonly<{
  state: RefreshPhaseStateValue;
  startedAt?: Date | null | undefined;
  completedAt?: Date | null | undefined;
  summary?: unknown;
}>;

export type CompleteRefreshRunInput = Readonly<{
  state: RefreshRunStateValue;
  completedAt: Date;
  failures: unknown;
  result: ScheduledRefreshResult;
}>;

export type RefreshRunStore = Readonly<{
  create: (input: CreateRefreshRunInput) => Promise<RefreshRunRecord>;
  get: (id: string) => Promise<RefreshRunRecord | null>;
  findActive: () => Promise<RefreshRunRecord | null>;
  listRecent: (limit: number) => Promise<readonly RefreshRunRecord[]>;
  setPhase: (
    runId: string,
    phase: RefreshPhaseName,
    input: SetRefreshPhaseInput,
  ) => Promise<RefreshRunRecord>;
  complete: (runId: string, input: CompleteRefreshRunInput) => Promise<RefreshRunRecord>;
  markInterrupted: (
    runId: string,
    input: Readonly<{ completedAt: Date; code: string }>,
  ) => Promise<RefreshRunRecord>;
}>;

export function createPrismaRefreshRunStore(): RefreshRunStore {
  return Object.freeze({
    create: async (input) => toRecord(await (await loadDb()).refreshRun.create({
      data: {
        id: input.id,
        triggeredBy: input.triggeredBy,
        attempt: input.attempt,
        resumedFromId: input.resumedFromId ?? null,
        startedAt: input.startedAt,
        phaseStates: toJson(initialPhaseStates(input.initialPhases)),
      },
    })),
    get: async (id) => {
      const row = await (await loadDb()).refreshRun.findUnique({ where: { id } });
      return row === null ? null : toRecord(row);
    },
    findActive: async () => {
      const row = await (await loadDb()).refreshRun.findFirst({
        where: { state: "RUNNING" },
        orderBy: { startedAt: "desc" },
      });
      return row === null ? null : toRecord(row);
    },
    listRecent: async (limit) => {
      const rows = await (await loadDb()).refreshRun.findMany({
        orderBy: { startedAt: "desc" },
        take: Math.max(1, Math.min(100, Math.floor(limit))),
      });
      return Object.freeze(rows.map(toRecord));
    },
    setPhase: async (runId, phase, input) => {
      const db = await loadDb();
      const row = await db.refreshRun.findUnique({ where: { id: runId } });
      if (row === null) {
        throw new RefreshRunNotFoundError(runId);
      }
      const record = toRecord(row);
      if (record.state !== "RUNNING") {
        throw new RefreshRunTransitionViolationError(
          `Cannot update phase ${phase} on run ${runId} in terminal state ${record.state}.`,
        );
      }
      assertLegalPhaseTransition(record.phases[phase].state, input.state);
      const phaseStates: Record<string, unknown> = {
        ...(row.phaseStates as Record<string, unknown>),
        [phase]: {
          state: input.state,
          startedAt: input.startedAt === undefined
            ? record.phases[phase].startedAt
            : input.startedAt?.toISOString() ?? null,
          completedAt: input.completedAt === undefined
            ? record.phases[phase].completedAt
            : input.completedAt?.toISOString() ?? null,
          summary: input.summary === undefined ? record.phases[phase].summary : input.summary,
        },
      };
      return toRecord(await db.refreshRun.update({
        where: { id: runId },
        data: { phaseStates: toJson(phaseStates) },
      }));
    },
    complete: async (runId, input) => {
      const db = await loadDb();
      const row = await db.refreshRun.findUnique({ where: { id: runId } });
      if (row === null) {
        throw new RefreshRunNotFoundError(runId);
      }
      const record = toRecord(row);
      assertLegalRunTransition(record.state, input.state);
      const expected = resolveTerminalRunState({
        rates: record.phases.rates.state,
        reputation: record.phases.reputation.state,
      });
      if (input.state !== expected) {
        throw new RefreshRunTransitionViolationError(
          `Cannot complete run ${runId} as ${input.state} with phases ` +
          `rates=${record.phases.rates.state} reputation=${record.phases.reputation.state}; ` +
          `expected ${expected}.`,
        );
      }
      return toRecord(await db.refreshRun.update({
        where: { id: runId },
        data: {
          state: input.state,
          completedAt: input.completedAt,
          failures: toJson(sanitizeRefreshFailures(input.failures)),
          result: toJson(input.result),
        },
      }));
    },
    markInterrupted: async (runId, input) => {
      const db = await loadDb();
      const row = await db.refreshRun.findUnique({ where: { id: runId } });
      if (row === null) {
        throw new RefreshRunNotFoundError(runId);
      }
      const record = toRecord(row);
      assertLegalRunTransition(record.state, "FAILED");
      return toRecord(await db.refreshRun.update({
        where: { id: runId },
        data: {
          state: "FAILED",
          completedAt: input.completedAt,
          failures: toJson(sanitizeRefreshFailures([
            ...record.failures,
            { phase: "ORCHESTRATION", code: input.code },
          ])),
        },
      }));
    },
  });
}

export class RefreshRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Refresh run ${runId} was not found.`);
    this.name = "RefreshRunNotFoundError";
  }
}

export class RefreshRunTransitionViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshRunTransitionViolationError";
  }
}

async function loadDb() {
  return (await import("@/lib/dbClient")).db;
}

function initialPhaseStates(
  carried?: Readonly<Partial<Record<RefreshPhaseName, RefreshPhaseProgress>>> | undefined,
): Record<string, RefreshPhaseProgress> {
  const states: Record<string, RefreshPhaseProgress> = {};
  for (const phase of REFRESH_PHASES) {
    states[phase] = { state: "PENDING", startedAt: null, completedAt: null, summary: null };
  }
  if (!carried) return states;
  for (const phase of REFRESH_PHASES) {
    const progress = carried[phase];
    if (progress?.state === "SUCCEEDED") {
      states[phase] = progress;
    }
  }
  return states;
}

/**
 * Prisma's JSON write input is stricter than `object`; every value written here
 * is produced by the bounded state-machine helpers above, never a raw remote
 * body, header, or stack.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

type RefreshRunRow = {
  id: string;
  triggeredBy: string;
  state: RefreshRunStateValue;
  attempt: number;
  resumedFromId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  phaseStates: unknown;
  failures: unknown;
  result: unknown;
};

function toRecord(row: RefreshRunRow): RefreshRunRecord {
  return Object.freeze({
    id: row.id,
    triggeredBy: row.triggeredBy,
    state: row.state,
    attempt: row.attempt,
    resumedFromId: row.resumedFromId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    phases: Object.freeze(parsePhaseStates(row.phaseStates)),
    failures: sanitizeRefreshFailures(row.failures),
    result: parseResult(row.result),
  });
}

function parsePhaseStates(input: unknown): Record<RefreshPhaseName, RefreshPhaseProgress> {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const phases = {} as Record<RefreshPhaseName, RefreshPhaseProgress>;
  for (const phase of REFRESH_PHASES) {
    phases[phase] = parsePhaseProgress(raw[phase]);
  }
  return phases;
}

function parsePhaseProgress(input: unknown): RefreshPhaseProgress {
  const fallback: RefreshPhaseProgress = Object.freeze({
    state: "PENDING",
    startedAt: null,
    completedAt: null,
    summary: null,
  });
  if (typeof input !== "object" || input === null) return fallback;
  const raw = input as Record<string, unknown>;
  const state = typeof raw.state === "string" && isPhaseStateValue(raw.state) ? raw.state : "PENDING";
  return Object.freeze({
    state,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    summary: raw.summary ?? null,
  });
}

function isPhaseStateValue(value: string): value is RefreshPhaseStateValue {
  return value === "PENDING" || value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "SKIPPED";
}

function parseResult(input: unknown): ScheduledRefreshResult | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.runId !== "string" || typeof raw.state !== "string") return null;
  if (!isTerminalResultState(raw.state)) return null;
  return raw as ScheduledRefreshResult;
}

function isTerminalResultState(value: string): boolean {
  return value === "succeeded" || value === "partially_succeeded" || value === "failed" || value === "already_running";
}
