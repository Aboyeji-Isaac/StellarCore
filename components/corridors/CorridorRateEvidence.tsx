import type { PublicRatesResponse } from "@/types/api/rates";

type Props = Readonly<{ rates: PublicRatesResponse }>;

function stateLabel(state: PublicRatesResponse["state"]): string {
  return state === "healthy" ? "Healthy" : "Insufficient fresh sources";
}

export function CorridorRateEvidence({ rates }: Props) {
  return (
    <section aria-labelledby="rate-evidence-heading" className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Persisted observations</p>
          <h2 id="rate-evidence-heading" className="mt-2 text-2xl" style={{ fontFamily: "var(--display)" }}>
            Latest rate evidence
          </h2>
        </div>
        <span
          className="rounded-full border border-[var(--ghost)] px-3 py-1 text-xs uppercase tracking-wide text-[var(--muted)]"
          data-state={rates.state}
        >
          {stateLabel(rates.state)}
        </span>
      </div>

      <div className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Median rate</dt>
            <dd className="mt-1 text-2xl text-[var(--white)]" style={{ fontFamily: "var(--display)" }}>
              {rates.medianRate ?? "Median unavailable"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Fresh evidence</dt>
            <dd className="mt-1 text-[var(--white)]">
              {rates.freshSourceCount} of {rates.medianRequirement.minimumFreshIndependentSources} required
            </dd>
            <dd className="mt-1 text-xs text-[var(--muted)]">
              Counts at most one observation per reviewed authority.
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Independent authorities</dt>
            <dd className="mt-1 text-[var(--white)]">
              {rates.independentAuthorityCount} across {rates.totalObservationCount}{" "}
              {rates.totalObservationCount === 1 ? "observation" : "observations"}
            </dd>
            <dd className="mt-1 text-xs text-[var(--muted)]">
              {rates.freshObservationCount} fresh before correlated observations are collapsed.
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Evaluated</dt>
            <dd className="mt-1 text-[var(--muted)]">{new Date(rates.evaluatedAt).toLocaleString()}</dd>
          </div>
        </dl>

        {rates.state === "insufficient_fresh_sources" ? (
          <p className="mt-5 border-t border-[var(--ghost)] pt-4 text-sm leading-relaxed text-[var(--muted)]">
            The API reports insufficient fresh sources, so no median is published. This page does not infer or
            substitute a price.
          </p>
        ) : null}

        {rates.observations.length === 0 ? (
          <p className="mt-5 border-t border-[var(--ghost)] pt-4 text-sm text-[var(--muted)]">
            No rate observations are currently persisted for this corridor.
          </p>
        ) : (
          <div className="mt-5 overflow-x-auto border-t border-[var(--ghost)] pt-4">
            <table className="w-full min-w-[780px] border-collapse text-left text-sm">
              <caption className="sr-only">Persisted rate observations</caption>
              <thead>
                <tr className="text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">Anchor</th>
                  <th className="px-3 py-2 font-medium">Authority</th>
                  <th className="px-3 py-2 font-medium">Rate</th>
                  <th className="px-3 py-2 font-medium">Captured</th>
                  <th className="px-3 py-2 font-medium">Freshness</th>
                  <th className="px-3 py-2 font-medium">Eligibility</th>
                </tr>
              </thead>
              <tbody>
                {rates.observations.map((observation) => (
                  <tr key={observation.anchor.slug} className="border-t border-[var(--ghost)] align-top">
                    <td className="px-3 py-3 text-[var(--white)]">{observation.anchor.name}</td>
                    <td className="px-3 py-3 text-[var(--muted)]">
                      {observation.authority.displayName
                        ?? observation.authority.id
                        ?? "Unknown authority"}
                    </td>
                    <td className="px-3 py-3 text-[var(--white)]">{observation.rate}</td>
                    <td className="px-3 py-3 text-[var(--muted)]">
                      {new Date(observation.capturedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-[var(--muted)]">{observation.freshness.state}</td>
                    <td className="px-3 py-3 text-[var(--muted)]">
                      {observation.eligibleForMedian
                        ? "Included"
                        : `Excluded${observation.exclusionReason ? ` — ${observation.exclusionReason.replace(/_/g, " ")}` : ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
