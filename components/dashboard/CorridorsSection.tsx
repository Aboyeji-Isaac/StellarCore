import * as React from "react";
import { getCorridorsApiResult, type CorridorsApiDependencies } from "@/lib/api/corridors";
import { createRequestId } from "@/lib/api/requestId";
import type { CorridorsApiResult } from "@/types/api/corridors";
import { SectionEmpty, SectionError } from "@/components/dashboard/SectionStates";

export async function CorridorsSection(props?: {
  dependencies?: CorridorsApiDependencies;
  result?: CorridorsApiResult;
}) {
  // Assign the correlation id here so the reference shown on failure is exactly
  // the id in the matching structured server log entry.
  const result = props?.result ?? await getCorridorsApiResult({
    ...(props?.dependencies ?? {}),
    requestId: createRequestId(),
  });
  return <CorridorsSectionView result={result} />;
}

export function CorridorsSectionView({ result }: { result: CorridorsApiResult }) {
  if (result.status !== 200) {
    const { code, message, requestId } = result.body.error;
    return (
      <SectionError
        area="corridors"
        code={code}
        message={message}
        requestId={requestId}
      />
    );
  }

  const { corridors, count } = result.body;

  if (count === 0) {
    return <SectionEmpty message="No corridors are currently persisted." />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ghost)]">
      <table className="w-full min-w-[480px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--ghost)] text-xs uppercase tracking-wide text-[var(--muted)]">
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium">Destination</th>
            <th className="px-4 py-3 font-medium text-right">Anchors</th>
          </tr>
        </thead>
        <tbody>
          {corridors.map((corridor) => (
            <tr key={corridor.slug} className="border-b border-[var(--ghost)] last:border-0">
              <td className="px-4 py-3 text-[var(--white)]">
                {corridor.sourceAsset} · {corridor.sourceCountry}
              </td>
              <td className="px-4 py-3 text-[var(--white)]">
                {corridor.destinationAsset} · {corridor.destinationCountry}
              </td>
              <td className="px-4 py-3 text-right text-[var(--muted)]">{corridor.anchorCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
