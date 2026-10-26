
import React from "react";

export function SectionError({
  message,
  onRetry,
  retryLabel = "Retry loading section",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(238,143,129,0.35)] bg-[rgba(238,143,129,0.08)] p-5 text-sm text-[#ee8f81]"
    >
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={retryLabel}
          className="rounded border border-[rgba(238,143,129,0.5)] bg-transparent px-3 py-1.5 text-xs font-medium text-[#ee8f81] transition hover:bg-[rgba(238,143,129,0.15)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          Retry
        </button>
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
