import { CONTROL_CHARACTER_PATTERN, OPERATOR_ACTION_LIMITS } from "@/constants/audit";
import type { OperatorActor, OperatorActorType } from "@/types/audit";

export type OperatorActorColumns = Readonly<{
  actorType: OperatorActorType;
  actorId: string | null;
}>;

/**
 * Maps a truthful actor to ledger columns. A system action never carries a
 * human identity; a human action carries only the id supplied by a trusted
 * authentication boundary. No identity is invented when none is available.
 */
export function operatorActorColumns(actor: OperatorActor): OperatorActorColumns {
  if (actor.kind === "system") {
    return Object.freeze({ actorType: "SYSTEM", actorId: null });
  }
  return Object.freeze({ actorType: "HUMAN", actorId: actor.id });
}

export function isValidActorId(value: string): boolean {
  const token = value.trim();
  return token.length >= 1
    && token.length <= OPERATOR_ACTION_LIMITS.actorIdMaxLength
    && !CONTROL_CHARACTER_PATTERN.test(token);
}
