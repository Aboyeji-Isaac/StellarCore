/**
 * Bounded cron-secret rotation model.
 *
 * `CRON_SECRET` remains the primary bearer secret. During a planned rotation,
 * `CRON_SECRET_PREVIOUS` may hold the outgoing secret and
 * `CRON_SECRET_ROTATION_UNTIL` bounds how long that previous secret keeps
 * authenticating (ISO-8601 UTC timestamp). This removes the cutover race
 * between scheduler and application deployments without letting an old secret
 * remain valid indefinitely.
 *
 * Failure-safety rules (every misconfiguration fails closed → 401):
 * - No primary secret: authentication is disabled entirely.
 * - Blank/whitespace values are treated as unset; a blank primary fails closed.
 * - A previous secret requires a parseable `ROTATION_UNTIL`; an incomplete
 *   rotation configuration rejects the previous slot entirely.
 * - Duplicate primary/previous values fail closed, never authenticate.
 * - An expired window deterministically revokes the previous secret.
 * - Secret values are never logged or surfaced; errors carry stable codes only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { getRuntimeConfig } from "@/lib/config/runtimeConfig";

export type CronRotationErrorCode =
  | "MISSING_PRIMARY_SECRET"
  | "DUPLICATE_ROTATION_SECRET"
  | "INVALID_ROTATION_TIMESTAMP";

export class CronRotationConfigurationError extends Error {
  readonly code: CronRotationErrorCode;

  constructor(code: CronRotationErrorCode) {
    const messages: Record<CronRotationErrorCode, string> = {
      MISSING_PRIMARY_SECRET: "CRON_SECRET is not configured.",
      DUPLICATE_ROTATION_SECRET:
        "CRON_SECRET_PREVIOUS must differ from CRON_SECRET.",
      INVALID_ROTATION_TIMESTAMP:
        "CRON_SECRET_ROTATION_UNTIL must be a valid future ISO-8601 timestamp.",
    };

    super(messages[code]);
    this.name = "CronRotationConfigurationError";
    this.code = code;
  }
}

export type CronRotationConfigInput = Readonly<{
  primarySecret: string | undefined;
  previousSecret: string | undefined;
  rotationUntil: string | undefined;
}>;

export type ResolvedCronRotation = Readonly<{
  primary: string;
  previous?: string;
  rotationUntil?: Date;
  overlapActive: boolean;
}>;

/**
 * Validates and resolves the rotation configuration at a point in time.
 * Throws `CronRotationConfigurationError` with a stable code on any
 * misconfiguration, so operational surfaces can validate explicitly without
 * handling secrets. Callers that only need an auth decision should prefer
 * `hasValidCronAuthorization`, which fails closed instead of throwing.
 */
export function resolveCronRotation(
  input: CronRotationConfigInput,
  now: () => number = Date.now,
): ResolvedCronRotation {
  const primary = requirePrimary(input.primarySecret);
  const previous = normalizeOptional(input.previousSecret);

  if (previous && previous === primary) {
    throw new CronRotationConfigurationError("DUPLICATE_ROTATION_SECRET");
  }

  let rotationUntil: Date | undefined;

  if (
    previous ||
    normalizeOptional(input.rotationUntil) !== undefined
  ) {
    rotationUntil = parseRotationTimestamp(input.rotationUntil);
  }

  if (previous && !rotationUntil) {
    throw new CronRotationConfigurationError("INVALID_ROTATION_TIMESTAMP");
  }

  const overlapActive = Boolean(
    previous &&
      rotationUntil &&
      rotationUntil.getTime() > now(),
  );

  return Object.freeze({
    primary,
    ...(previous && rotationUntil ? { previous, rotationUntil } : {}),
    overlapActive,
  });
}

/**
 * Timing-safe bearer verification with bounded rotation support.
 *
 * Fails closed: any missing, blank, duplicate, or malformed configuration
 * results in `false` (HTTP 401 at the boundary), never an open door and never
 * a thrown error on the request path. The previous secret authenticates only
 * while an explicitly configured, unexpired overlap window is active.
 */
export function hasValidCronAuthorization(
  authorization: string | null,
  secret?: string,
  previousSecret: string | undefined = process.env.CRON_SECRET_PREVIOUS,
  rotationUntil: string | undefined = process.env.CRON_SECRET_ROTATION_UNTIL,
  now: () => number = Date.now,
): boolean {
  let rotation: ResolvedCronRotation;

  try {
    const primarySecret = secret ?? getRuntimeConfig().cronSecret;

    rotation = resolveCronRotation(
      {
        primarySecret,
        previousSecret,
        rotationUntil,
      },
      now,
    );
  } catch {
    return false;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  if (!match) return false;

  const presented = digest(match[1]!);

  if (timingSafeEqual(digest(rotation.primary), presented)) {
    return true;
  }

  if (rotation.overlapActive && rotation.previous) {
    return timingSafeEqual(digest(rotation.previous), presented);
  }

  return false;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function requirePrimary(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new CronRotationConfigurationError("MISSING_PRIMARY_SECRET");
  }

  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseRotationTimestamp(value: string | undefined): Date {
  const parsed = new Date(value ?? "");

  if (
    normalizeOptional(value) === undefined ||
    Number.isNaN(parsed.getTime())
  ) {
    throw new CronRotationConfigurationError(
      "INVALID_ROTATION_TIMESTAMP",
    );
  }

  return parsed;
}