import React from "react";
import {
  dashboardFailureGuidance,
  type DashboardFailureArea,
} from "@/lib/dashboard/failureGuidance";

const ALERT_CLASS =
  "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(238,143,129,0.35)] bg-[rgba(238,143,129,0.08)] p-5 text-sm text-[#ee8f81]";

/**
 * The single dashboard error surface.
 *
 * With an `area`, the failure renders a plain-language heading for that data
 * area, a re-validated public message, recovery guidance that matches the
 * failure code, and (when available) the correlation reference to quote to
 * support. Without an `area` the original single-message rendering is kept for
 * callers that have no area context.
 */
export function SectionError({
  message,
  area,
  code,
  requestId,
  onRetry,
  retryLabel = "Retry loading section",
}: {
  message: string;
  area?: DashboardFailureArea;
  code?: string;
  requestId?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const retryControl = onRetry ? (
    <button
      type="button"
      onClick={onRetry}
      aria-label={retryLabel}
      className="rounded border border-[rgba(238,143,129,0.5)] bg-transparent px-3 py-1.5 text-xs font-medium text-[#ee8f81] transition hover:bg-[rgba(238,143,129,0.15)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      Retry
    </button>
  ) : null;

  if (!area) {
    return (
      <div role="alert" className={ALERT_CLASS}>
        <span>{message}</span>
        {retryControl}
      </div>
    );
  }

  const guidance = dashboardFailureGuidance(area, { code, message, requestId });

  return (
    <div
      role="alert"
      data-testid={`section-error-${area}`}
      data-error-code={guidance.code}
      className={ALERT_CLASS}
    >
      <div className="min-w-0">
        <p data-testid="section-error-title" className="text-sm font-medium text-[var(--white)]">
          {guidance.title}
        </p>
        <p data-testid="section-error-message" className="mt-1">
          {guidance.message}
        </p>
        <p data-testid="section-error-guidance" className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
          {guidance.guidance}
        </p>
        {guidance.reference ? (
          <p data-testid="section-error-reference" className="mt-1 break-all font-mono text-[11px] text-[var(--muted)]">
            Reference: {guidance.reference}
          </p>
        ) : null}
      </div>
      {retryControl}
    </div>
  );
}

export function SectionEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--ghost)] p-8 text-center text-sm text-[var(--muted)]">
      {message}
    </div>
  );
}

export function SectionSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="animate-pulse rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-8"
    >
      <div className="h-3 w-28 rounded bg-[var(--ghost)]" />
      <div className="mt-4 h-24 rounded bg-[var(--ghost)]" />
    </div>
  );
}
