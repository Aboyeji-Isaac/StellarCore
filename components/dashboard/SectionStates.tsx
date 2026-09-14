export function SectionError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-[rgba(238,143,129,0.35)] bg-[rgba(238,143,129,0.08)] p-5 text-sm text-[#ee8f81]"
    >
      {message}
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
