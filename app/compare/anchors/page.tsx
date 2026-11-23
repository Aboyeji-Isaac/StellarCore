import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getAnchorsApiResult } from "@/lib/api/anchors";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Compare anchors — StellarCore",
    description: "Side-by-side comparison of two reviewed anchors using existing public evidence.",
  };
}

function CompareAnchorsPage() {
  const pathname = usePathname();
  const router = useRouter();

  const [anchors, setAnchors] = useState<readonly any[]>([]);
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);

  // Load available anchors from the API
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      const result = await getAnchorsApiResult();
      if (!cancelled && result.status === 200) {
        setAnchors(result.body.anchors);
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const anchorOptions = anchors.map((anchor) => ({
    slug: anchor.slug,
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    status: anchor.status,
    seps: anchor.seps,
    corridorCount: anchor.corridorCount,
    isTransferCapable: anchor.isTransferCapable,
  }));

  function getStatusLabel(status: string): { tone: string; label: string } {
    switch (status) {
      case "LIVE":
        return { tone: "positive", label: "Synced" };
      case "DEGRADED":
        return { tone: "warning", label: "Sync degraded" };
      case "DOWN":
        return { tone: "negative", label: "Sync failed" };
      case "UNKNOWN":
        return { tone: "neutral", label: "Sync unknown" };
      default:
        return { tone: "neutral", label: status };
    }
  }

  function getSepLabels(seps: readonly number[]): string {
    if (seps.length === 0) return "—";
    return seps.map((sep) => `SEP-${sep}`).join(", ");
  }

  function getTransferLabel(capable: boolean): string {
    return capable ? "Transfer interface advertised" : "No transfer interface advertised";
  }

  return (
    <div className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12">
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] mb-6">
        <Link href="/dashboard" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]">Dashboard</Link>
        <span aria-hidden="true" className="px-2">/</span>
        <span className="text-lg" aria-current="page">Compare anchors</span>
      </nav>

      <header className="max-w-3xl">
        <p className="eyebrow">Anchor comparison</p>
        <h1 className="mt-2 text-3xl leading-tight sm:text-4xl" style={{ fontFamily: "var(--display)" }}>
          Compare two anchors
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
          Select up to two reviewed anchors to compare their configuration, synchronization state, and
          advertised capabilities. No prices, rates, or availability claims are made.
        </p>
      </header>

      {/* Selection form */}
      <section className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6">
        <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-4">
          Select anchors
        </h2>

        <p className="text-xs text-[var(--muted)] mb-6">
          Choose two anchors from the public list to compare. Selections are route-local only.
        </p>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Ensure two distinct selections
            if (selectedA && selectedB && selectedA !== selectedB) {
              router.push(`/compare/anchors/result?a=${selectedA}&b=${selectedB}`);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-[var(--muted)] mb-2">Anchor A</label>
              <select
                value={selectedA}
                onChange={(e) => setSelectedA(e.target.value || null)}
                className="w-full rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-2 text-[var(--white)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                disabled={anchors.length === 0}
              >
                <option value="">Select an anchor...</option>
                {anchorOptions.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name} ({a.slug})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-[var(--muted)] mb-2">Anchor B</label>
              <select
                value={selectedB}
                onChange={(e) => setSelectedB(e.target.value || null)}
                className="w-full rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-2 text-[var(--white)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                disabled={anchors.length <= 1}
              >
                <option value="">Select an anchor...</option>
                {anchorOptions.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name} ({a.slug})
                  </option>
                ))}
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

          {/* Find the two anchors */}
          const anchorA = anchorOptions.find((a) => a.slug === selectedA);
          const anchorB = anchorOptions.find((a) => a.slug === selectedB);

          if (!anchorA || !anchorB) {
            <p className="text-[var(--muted)]">One or both anchors not found.</p>
          } else {
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Anchor A details */}
              <div>
                <h3 className="text-lg font-medium mb-4">{anchorA.name}</h3>

                <dl className="mt-4 text-xs text-[var(--muted)]">
                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Home domain</dt>
                    <dd className="text-[var(--white)] line-clamp-2">{anchorA.homeDomain}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Synchronization status</dt>
                    <dd>
                      {anchorA.status && getStatusLabel(anchorA.status).label}
                      <span className={`ml-2 inline-flex items-center rounded-full border px-2 py-1 text-[0.6rem] font-medium ${anchorA.status === "LIVE" ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]" : anchorA.status === "DEGRADED" ? "bg-[rgba(243,184,100,0.14)] text-[#f3b864]" : anchorA.status === "DOWN" ? "bg-[rgba(238,143,129,0.14)] text-[#ee8f81]" : "bg-[var(--ghost)] text-[var(--muted)]"}`>
                        {getStatusLabel(anchorA.status).tone}
                      </span>
                    </dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Advertised SEPs</dt>
                    <dd className="text-[var(--white)]">{getSepLabels(anchorA.seps)}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Transfer interface</dt>
                    <dd className="text-[var(--white)]">{getTransferLabel(anchorA.isTransferCapable)}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Reviewed corridor count</dt>
                    <dd className="text-[var(--white)]">{anchorA.corridorCount}</dd>
                  </div>
                </dl>
              </div>

              {/* Anchor B details */}
              <div>
                <h3 className="text-lg font-medium mb-4">{anchorB.name}</h3>

                <dl className="mt-4 text-xs text-[var(--muted)]">
                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Home domain</dt>
                    <dd className="text-[var(--white)] line-clamp-2">{anchorB.homeDomain}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Synchronization status</dt>
                    <dd>
                      {anchorB.status && getStatusLabel(anchorB.status).label}
                      <span className={`ml-2 inline-flex items-center rounded-full border px-2 py-1 text-[0.6rem] font-medium ${anchorB.status === "LIVE" ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]" : anchorB.status === "DEGRADED" ? "bg-[rgba(243,184,100,0.14)] text-[#f3b864]" : anchorB.status === "DOWN" ? "bg-[rgba(238,143,129,0.14)] text-[#ee8f81]" : "bg-[var(--ghost)] text-[var(--muted)]"}`>
                        {getStatusLabel(anchorB.status).tone}
                      </span>
                    </dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Advertised SEPs</dt>
                    <dd className="text-[var(--white)]">{getSepLabels(anchorB.seps)}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Transfer interface</dt>
                    <dd className="text-[var(--white)]">{getTransferLabel(anchorB.isTransferCapable)}</dd>
                  </div>

                  <div>
                    <dt className="uppercase tracking-wide text-[var(--muted)]">Reviewed corridor count</dt>
                    <dd className="text-[var(--white)]">{anchorB.corridorCount}</dd>
                  </div>
                </dl>
              </div>
            </div>

            {/* Summary disclaimer */}
            <div className="mt-6 pt-6 border-t border-[var(--ghost)] text-xs text-[var(--muted)]">
              <p>Configuration data from public evidence. No price, rate, liquidity, or operational claims.</p>
              <p>Synchronization state reflects last persisted result, not live endpoint availability.</p>
            </div>
          }
        </section>
      )}
    </div>
  );
}

export default CompareAnchorsPage;