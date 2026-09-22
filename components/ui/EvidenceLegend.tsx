const EVIDENCE_STAGES = Object.freeze([
  Object.freeze({
    title: "Reviewed configuration",
    description: "Candidates intentionally configured for observation.",
  }),
  Object.freeze({
    title: "Stored observations",
    description: "Evidence captured and persisted by StellarCore.",
  }),
  Object.freeze({
    title: "Fresh independent evidence",
    description: "Recent observations from distinct anchors.",
  }),
  Object.freeze({
    title: "Median when sufficient",
    description: "Published only when the evidence threshold is met.",
  }),
]);

export function EvidenceLegend() {
  return (
    <aside
      className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-4 sm:p-5"
      aria-labelledby="evidence-legend-heading"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
        <p className="eyebrow">How to read the dashboard</p>
        <h2
          id="evidence-legend-heading"
          className="text-lg text-[var(--white)] sm:text-xl"
          style={{ fontFamily: "var(--display)" }}
        >
          Evidence layers are related, not interchangeable.
        </h2>
      </div>
      <ol className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--ghost)] bg-[var(--ghost)] sm:grid-cols-2 xl:grid-cols-4">
        {EVIDENCE_STAGES.map((stage, index) => (
          <li key={stage.title} className="bg-[var(--black)] p-3">
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 text-sm font-medium text-[var(--white)]">
              {stage.title}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {stage.description}
            </p>
          </li>
        ))}
      </ol>
    </aside>
  );
}
