/**
 * Explicit state machine for durable scheduled-refresh runs.
 *
 * Run lifecycle: RUNNING -> SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED.
 * Terminal states are final: a retry/resume creates a NEW run row linked
 * through resumedFromId instead of reopening a terminal row, so history stays
 * immutable and "exactly one active run" remains checkable.
 *
 * Phase lifecycle per phase: PENDING -> RUNNING -> SUCCEEDED | FAILED.
 * SKIPPED is reserved for phases an operator explicitly skips during a
 * documented manual recovery; the orchestrator never writes it on its own,
 * and a skipped required phase can never yield SUCCEEDED (see
 * resolveTerminalRunState).
 */

export const REFRESH_PHASES = Object.freeze(["rates", "reputation"] as const);

export type RefreshPhaseName = (typeof REFRESH_PHASES)[number];

export const REFRESH_RUN_STATES = Object.freeze([
  "RUNNING",
  "SUCCEEDED",
  "PARTIALLY_SUCCEEDED",
  "FAILED",
] as const);

export type RefreshRunStateValue = (typeof REFRESH_RUN_STATES)[number];

export const REFRESH_PHASE_STATES = Object.freeze([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
] as const);

export type RefreshPhaseStateValue = (typeof REFRESH_PHASE_STATES)[number];

export const TERMINAL_REFRESH_RUN_STATES: ReadonlySet<RefreshRunStateValue> =
  new Set(["SUCCEEDED", "PARTIALLY_SUCCEEDED", "FAILED"]);

export class RefreshRunTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshRunTransitionError";
  }
}

const LEGAL_PHASE_TRANSITIONS: Readonly<Record<RefreshPhaseStateValue, readonly RefreshPhaseStateValue[]>> = {
  PENDING: ["RUNNING", "SKIPPED"],
  RUNNING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: ["RUNNING"],
  SKIPPED: [],
};

const LEGAL_RUN_TRANSITIONS: Readonly<Record<RefreshRunStateValue, readonly RefreshRunStateValue[]>> = {
  RUNNING: ["SUCCEEDED", "PARTIALLY_SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  PARTIALLY_SUCCEEDED: [],
  FAILED: [],
};

export function assertLegalPhaseTransition(
  from: RefreshPhaseStateValue,
  to: RefreshPhaseStateValue,
): void {
  if (!LEGAL_PHASE_TRANSITIONS[from].includes(to)) {
    throw new RefreshRunTransitionError(
      `Illegal refresh phase transition from ${from} to ${to}.`,
    );
  }
}

export function assertLegalRunTransition(
  from: RefreshRunStateValue,
  to: RefreshRunStateValue,
): void {
  if (!LEGAL_RUN_TRANSITIONS[from].includes(to)) {
    throw new RefreshRunTransitionError(
      `Illegal refresh run transition from ${from} to ${to}.`,
    );
  }
}

/**
 * A run is successful only when every required phase reached SUCCEEDED.
 * Any other combination is a failure variant: partial success stays
 * distinguishable from complete success and from total failure, and missing
 * evidence or skipped phases are never converted into success.
 */
export function resolveTerminalRunState(
  phases: Readonly<Record<RefreshPhaseName, RefreshPhaseStateValue>>,
): Extract<RefreshRunStateValue, "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"> {
  const states = REFRESH_PHASES.map((phase) => phases[phase]);
  if (states.every((state) => state === "SUCCEEDED")) return "SUCCEEDED";
  if (states.some((state) => state === "SUCCEEDED")) return "PARTIALLY_SUCCEEDED";
  return "FAILED";
}

export function isRefreshPhaseName(value: unknown): value is RefreshPhaseName {
  return value === "rates" || value === "reputation";
}

/**
 * Bounded, sanitized failure metadata for the run ledger. Only whitelisted
 * scalar fields survive, each truncated to a safe length and matched against
 * an allowlist pattern; everything else (messages, stacks, headers, tokens,
 * raw response bodies, secrets) is dropped. At most MAX entries are kept.
 */
export const MAX_REFRESH_FAILURE_ENTRIES = 50;
const MAX_REFRESH_FAILURE_FIELD_LENGTH = 120;
const SAFE_FAILURE_FIELD_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

export type SanitizedRefreshFailure = Readonly<{
  phase: string;
  code: string;
  anchorSlug?: string | undefined;
  corridorSlug?: string | undefined;
}>;

export function sanitizeRefreshFailures(input: unknown): readonly SanitizedRefreshFailure[] {
  if (!Array.isArray(input)) return Object.freeze([]);
  const sanitized: SanitizedRefreshFailure[] = [];
  for (const entry of input) {
    if (sanitized.length >= MAX_REFRESH_FAILURE_ENTRIES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const code = sanitizeField(record.code, "UNKNOWN_FAILURE_CODE");
    const phase = sanitizeField(record.phase, "UNKNOWN_PHASE");
    const failure: { phase: string; code: string; anchorSlug?: string; corridorSlug?: string } = {
      phase,
      code,
    };
    const anchorSlug = sanitizeOptionalField(record.anchorSlug);
    if (anchorSlug !== undefined) failure.anchorSlug = anchorSlug;
    const corridorSlug = sanitizeOptionalField(record.corridorSlug);
    if (corridorSlug !== undefined) failure.corridorSlug = corridorSlug;
    sanitized.push(Object.freeze(failure));
  }
  return Object.freeze(sanitized);
}

function sanitizeField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, MAX_REFRESH_FAILURE_FIELD_LENGTH);
  return SAFE_FAILURE_FIELD_PATTERN.test(trimmed) ? trimmed : fallback;
}

function sanitizeOptionalField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX_REFRESH_FAILURE_FIELD_LENGTH);
  return SAFE_FAILURE_FIELD_PATTERN.test(trimmed) ? trimmed : undefined;
}
