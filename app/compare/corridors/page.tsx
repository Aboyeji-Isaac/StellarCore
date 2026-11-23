"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import type { PublicCorridor } from "@/types/api/corridors";

export const dynamic = "force-dynamic";

function CompareCorridorsPage() {
  const pathname = usePathname();
  const router = useRouter();

  const [corridors, setCorridors] = useState<readonly PublicCorridor[]>([]);
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);

  // Load available corridors from the API
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      const result = await getCorridorsApiResult();
      if (!cancelled && result.status === 200) {
        setCorridors(result.body.corridors);
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  function getStatusLabel(sourceAsset: string, destinationAsset: string): string {
    return `${sourceAsset} → ${destinationAsset}`;
  }

  function getCorridorStatusClassName(sourceAsset: string, destinationAsset: string): string {
    return `${sourceAsset} → ${destinationAsset}`;
  }

  // Find the two corridors before returning JSX
  const corridorA = corridors.find((c) => c.slug === selectedA);
  const corridorB = corridors.find((c) => c.slug === selectedB);

  return (
    <div className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12">
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] mb-6">
        <Link href="/dashboard" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]">Dashboard</Link>
        <span aria-hidden="true" className="px-2">/</span>
        <span className="text-lg" aria-current="page">Compare corridors</span>
      </nav>

      <header className="max-w-3xl">
        <p className="eyebrow">Corridor comparison</p>
        <h1 className="mt-2 text-3xl leading-tight sm:text-4xl" style={{ fontFamily: "var(--display)" }}>
          Compare two corridors
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
          Select two reviewed corridors to compare their asset pairs, source/destination countries, and
          associated anchor counts. Configuration data only — no prices, rates, or availability claims.
        </p>
      </header>

      {/* Selection form */}
      <section className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6">
        <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-4">
          Select corridors
        </h2>

        <p className="text-xs text-[var(--muted)] mb-6">
          Choose two corridors from the public list to compare. Selections are route-local only.
        </p>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (selectedA && selectedB && selectedA !== selectedB) {
              router.push(`/compare/corridors/result?a=${selectedA}&b=${selectedB}`);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-[var(--muted)] mb-2">Corridor A</label>
              <select
                value={selectedA || ""}
                onChange={(e) => setSelectedA(e.target.value || null)}
                className="w-full rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-2 text-[var(--white)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                disabled={corridors.length === 0}
              >
                <option value="">Select a corridor...</option>
                <option value="corridor-1">Corridor One (corridor-1)</option>
                <option value="corridor-2">Corridor Two (corridor-2)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-[var(--muted)] mb-2">Corridor B</label>
              <select
                value={selectedB || ""}
                onChange={(e) => setSelectedB(e.target.value || null)}
                className="w-full rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-2 text-[var(--white)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                disabled={corridors.length <= 1}
              >
                <option value="">Select a corridor...</option>
                <option value="corridor-3">Corridor Three (corridor-3)</option>
                <option value="corridor-4">Corridor Four (corridor-4)</option>
              </select>
            </div>
          </div>

          <button
            type="submit"
            className="mt-4 rounded-md px-4 py-2 text-[var(--white)] bg-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_90%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] text-sm"
            disabled={!selectedA || !selectedB || selectedA === selectedB}
          >
            Compare
          </button>
        </form>
      </section>

      {/* Comparison result */}
      {selectedA && selectedB && selectedA !== selectedB && (
        <section
          id="comparison-result"
          className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-6">
            Comparison: {selectedA} vs {selectedB}
          </h2>

          {corridorA && corridorB && (
            <div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Corridor A details */}
                <div>
                  <h3 className="text-lg font-medium mb-4">
                    {getStatusLabel(corridorA.sourceAsset, corridorA.destinationAsset)}
                  </h3>

                  <dl className="mt-4 text-xs text-[var(--muted)]">
                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Source asset</dt>
                      <dd className="text-[var(--white)]">{corridorA.sourceAsset}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Source country</dt>
                      <dd className="text-[var(--white)]">{corridorA.sourceCountry}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Destination asset</dt>
                      <dd className="text-[var(--white)]">{corridorA.destinationAsset}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Destination country</dt>
                      <dd className="text-[var(--white)]">{corridorA.destinationCountry}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Associated anchors</dt>
                      <dd className="text-[var(--white)]">{corridorA.anchorCount}</dd>
                    </div>
                  </dl>
                </div>

                {/* Corridor B details */}
                <div>
                  <h3 className="text-lg font-medium mb-4">
                    {getStatusLabel(corridorB.sourceAsset, corridorB.destinationAsset)}
                  </h3>

                  <dl className="mt-4 text-xs text-[var(--muted)]">
                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Source asset</dt>
                      <dd className="text-[var(--white)]">{corridorB.sourceAsset}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Source country</dt>
                      <dd className="text-[var(--white)]">{corridorB.sourceCountry}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Destination asset</dt>
                      <dd className="text-[var(--white)]">{corridorB.destinationAsset}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Destination country</dt>
                      <dd className="text-[var(--white)]">{corridorB.destinationCountry}</dd>
                    </div>

                    <div>
                      <dt className="uppercase tracking-wide text-[var(--muted)]">Associated anchors</dt>
                      <dd className="text-[var(--white)]">{corridorB.anchorCount}</dd>
                    </div>
                  </dl>
                </div>
              </div>

              {/* Summary disclaimer */}
              <div className="mt-6 pt-6 border-t border-[var(--ghost)] text-xs text-[var(--muted)]">
                <p>Configuration data from reviewed corridor data. No price, rate, liquidity, or operational claims.</p>
                <p>Anchor count reflects associated persisted anchors at time of review.</p>
              </div>
            </div>
          )}

        </section>
      )}
    </div>
  );
}

export default CompareCorridorsPage;