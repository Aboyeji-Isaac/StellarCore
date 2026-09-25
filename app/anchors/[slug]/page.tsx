import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnchorReputationEvidence } from "@/components/anchors/AnchorReputationEvidence";
import { syncStatusPresentation } from "@/components/anchors/syncStatusPresentation";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { ProductHeader } from "@/components/ui/ProductHeader";
import { SEPS } from "@/constants/seps";
import { getAnchorApiResult } from "@/lib/api/anchors";
import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { advertisedCapabilities } from "@/lib/stellar/advertisedCapabilities";

type Props = Readonly<{ params: Promise<Readonly<{ slug: string }>> }>;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const result = await getAnchorApiResult(slug);
  if (result.status !== 200) return { title: "Anchor not found — StellarCore" };

  const { anchor } = result.body;
  return {
    title: `${anchor.name} — StellarCore`,
    description: `Read-only evidence for the ${anchor.homeDomain} anchor.`,
  };
}

export default async function AnchorPage({ params }: Props) {
  const { slug } = await params;
  const anchorResult = await getAnchorApiResult(slug);
  if (anchorResult.status === 400 || anchorResult.status === 404) notFound();
  if (anchorResult.status !== 200) {
    return <ErrorState message={anchorResult.body.error.message} />;
  }

  const { anchor } = anchorResult.body;
  const reputationResult = await getAnchorReputationApiResult(slug);
  const capabilities = advertisedCapabilities(anchor.seps);
  const hasSep38 = capabilities.some(({ sep }) => sep === SEPS.SEP_38);
  const syncStatus = syncStatusPresentation(anchor.status);

  return (
    <>
      <ProductHeader current="dashboard" />
      <main
        id="main-content"
        className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12"
      >
        <div className="mx-auto max-w-6xl">
          <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)]">
            <Link href="/dashboard" className="underline underline-offset-4">
              Dashboard
            </Link>
            <span aria-hidden="true" className="px-2">
              /
            </span>
            <span aria-current="page">{anchor.slug}</span>
          </nav>

          <header className="mt-8 max-w-3xl">
            <p className="eyebrow">Anchor detail</p>
            <h1 className="mt-2 text-3xl leading-tight sm:text-4xl" style={{ fontFamily: "var(--display)" }}>
              {anchor.name}
            </h1>
            <p className="mt-2 font-mono text-xs text-[var(--muted)]">{anchor.homeDomain}</p>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
              Read-only anchor evidence from StellarCore&apos;s persisted APIs. Status describes persisted
              synchronization state, not current operation or availability, and advertised interfaces are
              metadata from the last successful SEP-1 synchronization.
            </p>
          </header>

          <section aria-labelledby="sync-heading" className="mt-10">
            <p className="eyebrow">Synchronization</p>
            <h2 id="sync-heading" className="mt-2 text-2xl" style={{ fontFamily: "var(--display)" }}>
              Last synchronization
            </h2>
            <div className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-[var(--muted)]">Persisted synchronization state</p>
                <EvidenceBadge tone={syncStatus.tone} label={syncStatus.label} />
              </div>
              <dl className="mt-4 grid gap-4 border-t border-[var(--ghost)] pt-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Slug</dt>
                  <dd className="mt-1 font-mono text-xs text-[var(--white)]">{anchor.slug}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Home domain</dt>
                  <dd className="mt-1 text-[var(--white)]">{anchor.homeDomain}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Associated corridors</dt>
                  <dd className="mt-1 text-[var(--white)]">{anchor.corridors.length}</dd>
                </div>
              </dl>
            </div>
          </section>

          <section aria-labelledby="capabilities-heading" className="mt-10">
            <p className="eyebrow">Advertised interfaces</p>
            <h2 id="capabilities-heading" className="mt-2 text-2xl" style={{ fontFamily: "var(--display)" }}>
              Advertised capabilities
            </h2>
            <div className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[var(--muted)]">
                  Advertised SEPs: <span className="text-[var(--white)]">{anchor.seps.length > 0 ? anchor.seps.join(", ") : "—"}</span>
                </p>
                <EvidenceBadge
                  tone="neutral"
                  label={anchor.isTransferCapable
                    ? "Transfer interface advertised"
                    : "No transfer interface advertised"}
                />
              </div>

              {capabilities.length > 0 ? (
                <ul className="mt-4 space-y-1.5 border-t border-[var(--ghost)] pt-4 text-[var(--muted)]">
                  {capabilities.map((capability) => (
                    <li key={capability.sep}>{capability.label}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 border-t border-[var(--ghost)] pt-4 text-[var(--muted)]">
                  No approved SEP capability label is available.
                </p>
              )}

              {hasSep38 ? (
                <p className="mt-4 border-t border-[var(--ghost)] pt-4 text-[var(--muted)]">
                  SEP-38 advertisement does not establish a reviewed indicative-rate source, current
                  freshness, or a firm quote.
                </p>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="corridors-heading" className="mt-10">
            <p className="eyebrow">Associated corridors</p>
            <h2 id="corridors-heading" className="mt-2 text-2xl" style={{ fontFamily: "var(--display)" }}>
              {anchor.corridors.length} {anchor.corridors.length === 1 ? "corridor" : "corridors"}
            </h2>
            {anchor.corridors.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                No corridors are currently associated with this anchor.
              </p>
            ) : (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {anchor.corridors.map((corridor) => (
                  <Link
                    key={corridor.slug}
                    href={`/corridors/${corridor.slug}`}
                    className="rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--accent)] focus-visible:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    <h3 className="text-lg text-[var(--white)]" style={{ fontFamily: "var(--display)" }}>
                      {corridor.sourceAsset} ({corridor.sourceCountry}) → {corridor.destinationAsset} (
                      {corridor.destinationCountry})
                    </h3>
                    <p className="mt-3 font-mono text-xs text-[var(--muted)]">{corridor.slug}</p>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="reputation-heading" className="mt-10">
            <p className="eyebrow">Reputation</p>
            <h2 id="reputation-heading" className="mt-2 text-2xl" style={{ fontFamily: "var(--display)" }}>
              Reputation evidence
            </h2>
            {reputationResult.status === 200 ? (
              <AnchorReputationEvidence reputation={reputationResult.body.reputation} />
            ) : (
              <p
                role="alert"
                className="mt-5 rounded-lg border border-[rgba(238,143,129,0.35)] p-5 text-sm text-[#ee8f81]"
              >
                {reputationResult.body.error.message}
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <main
      id="main-content"
      className="min-h-screen bg-[var(--black)] px-4 py-10 text-[var(--white)] sm:px-8"
    >
      <div
        className="mx-auto max-w-3xl rounded-lg border border-[rgba(238,143,129,0.35)] p-6 text-[#ee8f81]"
        role="alert"
      >
        {message}
      </div>
    </main>
  );
}
