/**
 * Finite limits for the operator-action audit boundary.
 *
 * These are mirrored by CHECK constraints in the ledger migration. The write
 * path validates the same limits so a caller receives a typed validation issue
 * instead of a database error.
 */
export const OPERATOR_ACTION_LIMITS = Object.freeze({
  actionIdMaxLength: 100,
  targetIdMaxLength: 200,
  targetLabelMaxLength: 200,
  rationaleMaxLength: 500,
  actorIdMaxLength: 200,
  runIdMaxLength: 100,
  inspectionDefaultLimit: 50,
  inspectionMaxLimit: 200,
});

/** Stable identifier vocabulary for correlation ids and action ids. */
export const OPERATOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Control characters (including newlines) are rejected from every bounded text
 * field. Audit rows never store payloads, so there is no legitimate use for
 * them, and rejecting them keeps inspection output single-line and sanitized.
 */
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
