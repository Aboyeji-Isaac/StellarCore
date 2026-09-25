import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import type {
  PublicReputation,
  PublicReputationScoreBand,
  PublicReputationState,
} from "@/types/api/reputation";

function stateCopy(state: PublicReputationState): string {
  switch (state) {
    case "established":
      return "Established";
    case "insufficient_evidence":
      return "Insufficient evidence";
    case "not_evaluated":
      return "Not yet evaluated";
  }
}

function stateTone(state: PublicReputationState) {
  return state === "established" ? ("positive" as const) : ("neutral" as const);
}

function bandTone(band: PublicReputationScoreBand) {
  switch (band) {
    case "green":
      return "positive" as const;
    case "amber":
      return "warning" as const;
    case "red":
      return "negative" as const;
  }
}

function formatMetric(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

/**
 * The dashboard's reputation evidence presentation, applied to a single anchor.
 * Persisted state, published score, or the explicit insufficient-evidence
 * language is shown verbatim; no score is inferred here.
 */
export function AnchorReputationEvidence({
  reputation,
}: Readonly<{ reputation: PublicReputation }>) {
  return (
    <article className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="eyebrow">Evaluation state</p>
        <EvidenceBadge tone={stateTone(reputation.state)} label={stateCopy(reputation.state)} />
      </div>

      {reputation.state === "established" && reputation.score !== null ? (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-3xl text-[var(--white)]" style={{ fontFamily: "var(--display)" }}>
            {reputation.score}
          </span>
          <span className="text-xs text-[var(--muted)]">/100</span>
          {reputation.scoreBand ? (
            <EvidenceBadge tone={bandTone(reputation.scoreBand)} label={reputation.scoreBand} />
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-[var(--muted)]">
          {reputation.state === "not_evaluated"
            ? "This anchor has no persisted evaluation yet."
            : "Evidence is too sparse for a published score."}
        </p>
      )}

      {reputation.evidence ? (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Outcomes evaluated: <span className="text-[var(--white)]">{reputation.evidence.outcomeCount}</span>
        </p>
      ) : null}

      {reputation.metrics ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--ghost)] pt-3 text-xs text-[var(--muted)]">
          <div>
            <dt>Fill rate 7d</dt>
            <dd className="text-[var(--white)]">{formatMetric(reputation.metrics.fillRate7d)}</dd>
          </div>
          <div>
            <dt>Fill rate 30d</dt>
            <dd className="text-[var(--white)]">{formatMetric(reputation.metrics.fillRate30d)}</dd>
          </div>
          <div>
            <dt>Fill rate 90d</dt>
            <dd className="text-[var(--white)]">{formatMetric(reputation.metrics.fillRate90d)}</dd>
          </div>
          <div>
            <dt>Settlement p50</dt>
            <dd className="text-[var(--white)]">{formatMs(reputation.metrics.settleP50Ms)}</dd>
          </div>
          <div>
            <dt>Settlement p95</dt>
            <dd className="text-[var(--white)]">{formatMs(reputation.metrics.settleP95Ms)}</dd>
          </div>
          <div>
            <dt>Slippage p50</dt>
            <dd className="text-[var(--white)]">{formatMetric(reputation.metrics.slippageP50)}</dd>
          </div>
        </dl>
      ) : null}

      {reputation.computedAt ? (
        <p className="mt-3 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          Computed {new Date(reputation.computedAt).toLocaleString()}
        </p>
      ) : null}
    </article>
  );
}
