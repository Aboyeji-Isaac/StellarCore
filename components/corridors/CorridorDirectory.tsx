"use client";

import { useMemo, useState } from "react";
import type { PublicCorridor } from "@/types/api/corridors";
import { searchCorridors } from "@/lib/frontend/corridorSearch";

type CorridorDirectoryProps = Readonly<{
  corridors: readonly PublicCorridor[];
}>;

export function CorridorDirectory({ corridors }: CorridorDirectoryProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => searchCorridors(corridors, query),
    [corridors, query],
  );

  return (
    <div className="mt-9">
      <label
        htmlFor="corridor-search"
        className="block text-xs uppercase tracking-[0.2em] text-[var(--muted)]"
      >
        Search corridors
      </label>
      <input
        id="corridor-search"
        type="search"
        inputMode="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="e.g. USDC, BRL, NG, US…"
        className="mt-2 w-full max-w-md rounded-lg border border-[var(--ghost)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--white)] placeholder:text-[var(--muted)] focus:border-[var(--white)] focus:outline-none"
      />

      <p className="mt-5 text-xs text-[var(--muted)]" aria-live="polite">
        {filtered.length} of {corridors.length} corridor{corridors.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          No corridors match your search.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--ghost)]">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--ghost)] text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Destination</th>
                <th className="px-4 py-3 font-medium text-right">Anchors</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((corridor) => (
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
      )}
    </div>
  );
}