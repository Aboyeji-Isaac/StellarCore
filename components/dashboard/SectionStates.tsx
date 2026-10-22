import * as React from "react";

import {
  dashboardFailureGuidance,
  type DashboardDataArea,
} from "@/lib/dashboard/failureGuidance";

/**
 * The only dashboard error surface: it states which data area failed in plain
 * language, gives recovery steps that match the failure (retry only where a
 * reload can help), and never renders raw exception text. Only safe registry
 * codes and public messages reach this component, and the id is validated again
 * before it is shown as a support reference.
 */
export function SectionError({
  area,
  code,
  message,
  requestId,
}: {
  area: DashboardDataArea;
  code: string;
  message: string;
  requestId?: string;
}) {
  const guidance = dashboardFailureGuidance(area, { code, message, requestId });

  return (
    <div
      role="alert"
      data-testid={`section-error-${guidance.area}`}
      data-error-code={guidance.code}
      className="rounded-lg border border-[rgba(238,143,129,0.35)] bg-[rgba(238,143,129,0.08)] p-5 text-sm text-[#ee8f81]"
    >
      <p className="font-medium" data-testid="section-error-title">
        {guidance.title}
      </p>
      <p className="mt-1" data-testid="section-error-message">
        {guidance.message}
      </p>
      <p
        className="mt-2 text-xs leading-relaxed text-[var(--muted)]"
        data-testid="section-error-guidance"
      >
        {guidance.guidance}
      </p>
      {guidance.reference ? (
        <p
          className="mt-2 font-mono text-[10px] text-[var(--muted)]"
          data-testid="section-error-reference"
        >
          Reference: {guidance.reference}
        </p>
      ) : null}
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
