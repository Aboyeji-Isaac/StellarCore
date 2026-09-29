import type {
  RateObservationDispositionAction as DispositionAction,
  RateObservationDispositionReason as DispositionReason,
} from "@/app/generated/prisma/enums";
import type { BlockingDispositionState } from "@/types/rates";

/**
 * Reviewed state machine for maintainer dispositions about persisted rate
 * observations. A disposition is a statement about whether an observation
 * may be used as evidence. It is not a finding that an anchor acted
 * maliciously or was unavailable, and it never changes the observation.
 *
 *   active      -> QUARANTINE -> quarantined
 *   active      -> INVALIDATE -> invalidated (terminal)
 *   active      -> SUPERSEDE  -> superseded  (terminal)
 *   quarantined -> RELEASE    -> active
 *   quarantined -> INVALIDATE -> invalidated (terminal)
 *   quarantined -> SUPERSEDE  -> superseded  (terminal)
 *
 * The migration enforces the same rules with a database trigger.
 */
export type { DispositionAction, DispositionReason };

export type DispositionState = "active" | "quarantined" | "invalidated" | "superseded";
export type { BlockingDispositionState };

export const DISPOSITION_ACTIONS = Object.freeze([
  "QUARANTINE",
  "INVALIDATE",
  "SUPERSEDE",
  "RELEASE",
] as const satisfies readonly DispositionAction[]);

export const REASONS_BY_ACTION: Readonly<Record<DispositionAction, readonly DispositionReason[]>> =
  Object.freeze({
    QUARANTINE: Object.freeze([
      "SUSPECTED_INCORRECT_VALUE",
      "SUSPECTED_SOURCE_COMPROMISE",
      "SUSPECTED_INVALID_CONFIGURATION",
    ] as const),
    INVALIDATE: Object.freeze([
      "SEMANTICALLY_INCORRECT",
      "SOURCE_COMPROMISED",
      "INVALID_CONFIGURATION",
      "NORMALIZATION_DEFECT",
    ] as const),
    SUPERSEDE: Object.freeze([
      "SEMANTICALLY_INCORRECT",
      "INVALID_CONFIGURATION",
      "NORMALIZATION_DEFECT",
    ] as const),
    RELEASE: Object.freeze(["REVIEW_CLEARED"] as const),
  });

const TRANSITIONS: Readonly<Record<DispositionState, Partial<Record<DispositionAction, DispositionState>>>> =
  Object.freeze({
    active: { QUARANTINE: "quarantined", INVALIDATE: "invalidated", SUPERSEDE: "superseded" },
    quarantined: { RELEASE: "active", INVALIDATE: "invalidated", SUPERSEDE: "superseded" },
    invalidated: {},
    superseded: {},
  });

export function stateAfterAction(action: DispositionAction | null | undefined): DispositionState {
  switch (action) {
    case "QUARANTINE": return "quarantined";
    case "INVALIDATE": return "invalidated";
    case "SUPERSEDE": return "superseded";
    default: return "active";
  }
}

export type DispositionErrorCode =
  | "INVALID_ACTION"
  | "INVALID_SNAPSHOT_ID"
  | "INVALID_REASON"
  | "INVALID_REVIEW_REFERENCE"
  | "INVALID_ACTOR"
  | "INVALID_NOTE"
  | "REPLACEMENT_REQUIRED"
  | "REPLACEMENT_NOT_ALLOWED"
  | "SELF_SUPERSESSION"
  | "SNAPSHOT_NOT_FOUND"
  | "REPLACEMENT_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "INCOMPATIBLE_REPLACEMENT"
  | "REPLACEMENT_NOT_LATER"
  | "REPLACEMENT_NOT_ACTIVE"
  | "CONCURRENT_MODIFICATION"
  | "REJECTED_BY_DATABASE"
  | "PERSISTENCE_FAILURE";

export type DispositionFailure = Readonly<{ ok: false; code: DispositionErrorCode }>;

export type DispositionRequest = Readonly<{
  action: DispositionAction;
  snapshotId: string;
  reasonCode: DispositionReason;
  reviewReference: string;
  actor: string;
  note?: string;
  supersededBySnapshotId?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors the migration's CHECK constraints.
const REVIEW_REFERENCE = /^[A-Za-z0-9#._:/?=&%+-]{1,200}$/;
const ACTOR = /^[A-Za-z0-9_.@-]{1,100}$/;
const MAX_NOTE_LENGTH = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validates and normalizes untrusted operator input. The optional note has
 * its whitespace collapsed, is trimmed, must be at most 500 characters, and
 * may not contain control characters.
 */
export function validateDispositionRequest(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ ok: true; request: DispositionRequest }> | DispositionFailure {
  const action = input.action;
  if (typeof action !== "string" || !(DISPOSITION_ACTIONS as readonly string[]).includes(action)) {
    return failure("INVALID_ACTION");
  }
  const typedAction = action as DispositionAction;

  if (typeof input.snapshotId !== "string" || !UUID.test(input.snapshotId)) {
    return failure("INVALID_SNAPSHOT_ID");
  }
  if (typeof input.reasonCode !== "string" ||
    !(REASONS_BY_ACTION[typedAction] as readonly string[]).includes(input.reasonCode)) {
    return failure("INVALID_REASON");
  }
  if (typeof input.reviewReference !== "string" || !REVIEW_REFERENCE.test(input.reviewReference)) {
    return failure("INVALID_REVIEW_REFERENCE");
  }
  if (typeof input.actor !== "string" || !ACTOR.test(input.actor)) {
    return failure("INVALID_ACTOR");
  }

  let note: string | undefined;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") return failure("INVALID_NOTE");
    const normalized = input.note.replace(/\s+/g, " ").trim();
    if (normalized.length > MAX_NOTE_LENGTH || CONTROL_CHARACTERS.test(normalized)) {
      return failure("INVALID_NOTE");
    }
    if (normalized.length > 0) note = normalized;
  }

  const replacement = input.supersededBySnapshotId;
  if (typedAction === "SUPERSEDE") {
    if (typeof replacement !== "string" || !UUID.test(replacement)) return failure("REPLACEMENT_REQUIRED");
    if (replacement.toLowerCase() === input.snapshotId.toLowerCase()) return failure("SELF_SUPERSESSION");
  } else if (replacement !== undefined && replacement !== null) {
    return failure("REPLACEMENT_NOT_ALLOWED");
  }

  return Object.freeze({
    ok: true,
    request: Object.freeze({
      action: typedAction,
      snapshotId: input.snapshotId.toLowerCase(),
      reasonCode: input.reasonCode as DispositionReason,
      reviewReference: input.reviewReference,
      actor: input.actor,
      ...(note ? { note } : {}),
      ...(typedAction === "SUPERSEDE"
        ? { supersededBySnapshotId: (replacement as string).toLowerCase() }
        : {}),
    }),
  });
}

export type DispositionSubject = Readonly<{
  id: string;
  anchorId: string;
  corridorId: string;
  capturedAt: Date;
  /** Latest recorded event, or null when the snapshot has none. */
  lastAction: DispositionAction | null;
  lastSequence: number;
}>;

export type DispositionPlan = Readonly<{
  ok: true;
  sequence: number;
  fromState: DispositionState;
  toState: DispositionState;
}>;

/**
 * Decides whether a validated request may be recorded. A replacement must be
 * a different, currently active observation of the same anchor and corridor,
 * captured strictly later. Strict capture ordering makes supersession chains
 * acyclic, and requiring an active replacement prevents chaining through
 * unusable evidence. No synthetic correction row is ever created.
 */
export function planDisposition(
  request: DispositionRequest,
  target: DispositionSubject | null,
  replacement: DispositionSubject | null,
): DispositionPlan | DispositionFailure {
  if (!target) return failure("SNAPSHOT_NOT_FOUND");
  const fromState = stateAfterAction(target.lastAction);
  const toState = TRANSITIONS[fromState][request.action];
  if (!toState) return failure("ILLEGAL_TRANSITION");

  if (request.action === "SUPERSEDE") {
    if (!replacement) return failure("REPLACEMENT_NOT_FOUND");
    if (replacement.id === target.id) return failure("SELF_SUPERSESSION");
    if (replacement.anchorId !== target.anchorId || replacement.corridorId !== target.corridorId) {
      return failure("INCOMPATIBLE_REPLACEMENT");
    }
    if (replacement.capturedAt.getTime() <= target.capturedAt.getTime()) {
      return failure("REPLACEMENT_NOT_LATER");
    }
    if (stateAfterAction(replacement.lastAction) !== "active") {
      return failure("REPLACEMENT_NOT_ACTIVE");
    }
  }

  return Object.freeze({ ok: true, sequence: target.lastSequence + 1, fromState, toState });
}

function failure(code: DispositionErrorCode): DispositionFailure {
  return Object.freeze({ ok: false, code });
}

/**
 * Maps a snapshot's latest event to the public blocking disposition, or null
 * when the snapshot is usable (no event, or released from quarantine).
 */
export function toBlockingDisposition(
  action: string | null | undefined,
  reasonCode: string | null | undefined,
  recordedAt: Date | null | undefined,
): Readonly<{ state: BlockingDispositionState; reasonCode: string; recordedAt: string }> | null {
  const state = stateAfterAction(action as DispositionAction | null | undefined);
  if (state === "active" || !reasonCode || !recordedAt) return null;
  return Object.freeze({ state, reasonCode, recordedAt: recordedAt.toISOString() });
}

/**
 * SQL fragment joining the latest disposition event of `<alias>.id` as
 * `disposition`. The alias is a fixed identifier chosen by the caller.
 */
export function latestDispositionJoin(alias: "latest" | "observation"): string {
  return `
  LEFT JOIN LATERAL (
    SELECT event.action::text AS action, event.reason_code::text AS reason_code, event.recorded_at
      FROM rate_observation_dispositions AS event
     WHERE event.snapshot_id = ${alias}.id
     ORDER BY event.sequence DESC
     LIMIT 1
  ) AS disposition ON true`;
}
