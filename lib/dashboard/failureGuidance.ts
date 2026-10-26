/**
 * User-facing recovery guidance for failed dashboard panels.
 *
 * A failed panel must answer three questions without exposing internals: which
 * data area failed, what the reader can do next, and how to report it. This
 * module is the single place that turns a public API failure into that copy.
 *
 * Safety rules:
 * - The public API message is re-validated before it is rendered. Stack frames,
 *   credentials, URLs/connection strings, SQL, driver messages, and control
 *   characters are replaced with a generic area message. This is defence in
 *   depth: the API already returns only safe messages.
 * - Retry guidance appears only for codes where a reload can actually help.
 *   A missing or invalid identifier fails identically on every attempt.
 * - The correlation reference is rendered only when it is a valid request id.
 */

import {
  isPublicApiErrorCode,
  isRecoverablePublicApiErrorCode,
  type PublicApiErrorCode,
} from "@/types/api/errors";
import { isValidRequestId } from "@/lib/api/requestId";

export type DashboardFailureArea =
  | "anchors"
  | "corridors"
  | "rates"
  | "reputation"
  | "rate-history";

export type DashboardFailureInput = Readonly<{
  code?: string | undefined;
  message?: string | undefined;
  requestId?: string | undefined;
}>;

export type DashboardFailureGuidance = Readonly<{
  area: DashboardFailureArea;
  areaLabel: string;
  title: string;
  code: PublicApiErrorCode | "unknown_error";
  message: string;
  guidance: string;
  retry: boolean;
  reference: string | null;
}>;

type AreaPresentation = Readonly<{
  /** Plain-language area name used in sentences, e.g. "the anchor directory". */
  subject: string;
  /** Panel heading, e.g. "Anchor directory unavailable". */
  title: string;
}>;

const AREA_PRESENTATION: Readonly<Record<DashboardFailureArea, AreaPresentation>> = Object.freeze({
  anchors: Object.freeze({
    subject: "the anchor directory",
    title: "Anchor directory unavailable",
  }),
  corridors: Object.freeze({
    subject: "the corridor directory",
    title: "Corridor directory unavailable",
  }),
  rates: Object.freeze({
    subject: "rate evidence",
    title: "Rate evidence unavailable",
  }),
  reputation: Object.freeze({
    subject: "reputation evidence",
    title: "Reputation evidence unavailable",
  }),
  "rate-history": Object.freeze({
    subject: "rate history",
    title: "Rate history unavailable",
  }),
});

const RETRY_GUIDANCE =
  "This panel is read live. Reload the page to retry; if it still fails, report it with the reference below.";
const RATE_LIMIT_GUIDANCE =
  "Too many requests were sent from this network. Wait a minute, then reload the page.";
const TERMINAL_GUIDANCE =
  "Reloading will not change this result. Check the link or the selection before trying again.";
const UNKNOWN_GUIDANCE =
  "Reload the page to try again. If it still fails, report it with the reference below.";

const MAX_PUBLIC_MESSAGE_LENGTH = 160;

/** Patterns that only appear in internal diagnostics, never in safe copy. */
const UNSAFE_MESSAGE_PATTERNS: readonly RegExp[] = Object.freeze([
  /[\u0000-\u001f\u007f]/,
  /[<>]/,
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\b\s*[:=]/i,
  /\bbearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{4,}\./,
  /(?:^|\s)at\s+[\w$.]+\s*\(/,
  /\.[cm]?[jt]sx?:\d+:\d+/,
  /\b(?:select|insert|update|delete)\b[\s\S]{0,80}\b(?:from|into|set|where)\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|PrismaClient\w*|PostgresError)\b/,
  /^error:\s/i,
]);

/**
 * Returns a render-safe message for an area. Legitimate public API copy is kept
 * verbatim; anything that looks like internal diagnostics becomes a generic
 * "Unable to load …" sentence for that area.
 */
export function safeFailureMessage(area: DashboardFailureArea, message: unknown): string {
  const fallback = `Unable to load ${areaSubject(area)}.`;
  if (typeof message !== "string") return fallback;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_PUBLIC_MESSAGE_LENGTH) return fallback;
  if (UNSAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return trimmed;
}

/**
 * Pure, deterministic guidance for one failed panel. No I/O, no clock, and no
 * mutation: the same failure always produces the same copy.
 */
export function dashboardFailureGuidance(
  area: DashboardFailureArea,
  failure: DashboardFailureInput = {},
): DashboardFailureGuidance {
  const presentation = AREA_PRESENTATION[area];
  const code = normalizeCode(failure.code);

  return Object.freeze({
    area,
    areaLabel: presentation.subject,
    title: presentation.title,
    code,
    message: safeFailureMessage(area, failure.message),
    guidance: guidanceFor(code),
    // Retry copy is offered only where a reload can plausibly succeed: a
    // transient failure or an unclassified one. Terminal contract violations
    // keep explicit "reloading will not help" copy instead.
    retry: code === "unknown_error" || isRecoverablePublicApiErrorCode(code),
    reference: isValidRequestId(failure.requestId) ? failure.requestId : null,
  });
}

function areaSubject(area: DashboardFailureArea): string {
  return AREA_PRESENTATION[area].subject;
}

function normalizeCode(code: string | undefined): PublicApiErrorCode | "unknown_error" {
  return isPublicApiErrorCode(code) ? code : "unknown_error";
}

function guidanceFor(code: PublicApiErrorCode | "unknown_error"): string {
  if (code === "rate_limited") return RATE_LIMIT_GUIDANCE;
  if (code === "unknown_error") return UNKNOWN_GUIDANCE;
  return isRecoverablePublicApiErrorCode(code) ? RETRY_GUIDANCE : TERMINAL_GUIDANCE;
}
