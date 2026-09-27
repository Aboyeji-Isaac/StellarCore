"use client";

import { useMemo, useState } from "react";
import type { PublicAnchorSummary } from "@/types/api/anchors";
import {
  availableSepFilters,
  filterAnchorsBySeps,
} from "@/lib/frontend/anchorDirectoryFilter";

type AnchorDirectoryProps = Readonly<{
  anchors: readonly PublicAnchorSummary[];
}>;

export function AnchorDirectory({ anchors }: AnchorDirectoryProps) {
  const [selectedSeps, setSelectedSeps] = useState<ReadonlySet<number>>(new Set());

  const sepOptions = useMemo(() => availableSepFilters(anchors), [anchors]);
  const filtered = useMemo(
    () => filterAnchorsBySeps(anchors, selectedSeps),
    [anchors, selectedSeps],
  );

  function toggleSep(sep: number): void {
    setSelectedSeps((current) => {
      const next = new Set(current);
      if (next.has(sep)) {
        next.delete(sep);
      } else {
        next.add(sep);
      }
      return next;
    });
  }

  return (
    <div className="mt-9">
      {sepOptions.length > 0 ? (
        <fieldset className="flex flex-wrap items-center gap-2" aria-label="Filter anchors by SEP support">
          <legend className="sr-only">Filter anchors by advertised SEP support</legend>
          {sepOptions.map((sep) => {
            const selected = selectedSeps.has(sep);
            return (
              <button
                key={sep}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleSep(sep)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  selected
                    ? "border-[var(--white)] bg-[var(--white)] text-[var(--black)]"
                    : "border-[var(--ghost)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--white)]"
                }`}
              >
                SEP-{sep}
              </button>
            );
          })}
          {selectedSeps.size > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedSeps(new Set())}
              className="rounded-full px-3 py-1.5 text-sm text-[var(--muted)] underline-offset-2 hover:text-[var(--white)] hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </fieldset>
      ) : null}

      <p className="mt-5 text-xs text-[var(--muted)]" aria-live="polite">
        {filtered.length} of {anchors.length} anchor{anchors.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          No anchors advertise the selected SEP support.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((anchor) => (
            <article
              key={anchor.slug}
              className="rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5"
            >
              <div>
                <h2 className="text-lg text-[var(--white)]" style={{ fontFamily: "var(--display)" }}>
                  {anchor.name}
                </h2>
                <p className="mt-1 text-xs text-[var(--muted)]">{anchor.homeDomain}</p>
                <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{anchor.slug}</p>
              </div>
              <dl className="mt-4 flex items-center justify-between border-t border-[var(--ghost)] pt-3 text-xs">
                <div>
                  <dt className="uppercase tracking-wide text-[var(--muted)]">Advertised SEPs</dt>
                  <dd className="mt-1 text-[var(--white)]">
                    {anchor.seps.length > 0 ? anchor.seps.map((sep) => `SEP-${sep}`).join(", ") : "—"}
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="uppercase tracking-wide text-[var(--muted)]">Corridors</dt>
                  <dd className="mt-1 text-[var(--white)]">{anchor.corridorCount}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}