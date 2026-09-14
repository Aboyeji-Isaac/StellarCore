import { Suspense } from "react";
import type { Metadata } from "next";
import { AnchorsSection } from "@/components/dashboard/AnchorsSection";
import { CorridorsSection } from "@/components/dashboard/CorridorsSection";
import { RatePanel } from "@/components/dashboard/RatePanel";
import { ReputationSection } from "@/components/dashboard/ReputationSection";
import { SectionSkeleton } from "@/components/dashboard/SectionStates";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard — StellarCore",
  description: "Live, read-only view of Stellar anchors, corridors, rates, and reputation.",
};

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-[var(--black)] px-4 py-16 text-[var(--white)] sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <header className="max-w-2xl">
          <p className="eyebrow">Public dashboard</p>
          <h1 className="mt-3 text-4xl leading-tight sm:text-5xl" style={{ fontFamily: "var(--display)" }}>
            StellarCore at a glance
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-[var(--muted)]">
            A read-only view of what StellarCore has persisted: synchronized anchors, discovered corridors,
            the latest USDC → BRL rate observations, and each anchor&apos;s reputation evaluation. Nothing
            here is calculated in the browser — every value is shown exactly as the public API returns it,
            including nulls and insufficient-evidence states.
          </p>
        </header>

        <section className="mt-16" aria-labelledby="anchors-heading">
          <h2 id="anchors-heading" className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            Anchors
          </h2>
          <div className="mt-4">
            <Suspense fallback={<SectionSkeleton label="anchors" />}>
              <AnchorsSection />
            </Suspense>
          </div>
        </section>

        <section className="mt-16" aria-labelledby="corridors-heading">
          <h2 id="corridors-heading" className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            Corridors
          </h2>
          <div className="mt-4">
            <Suspense fallback={<SectionSkeleton label="corridors" />}>
              <CorridorsSection />
            </Suspense>
          </div>
        </section>

        <section className="mt-16" aria-labelledby="rates-heading">
          <h2 id="rates-heading" className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            USDC → BRL rate
          </h2>
          <div className="mt-4">
            <Suspense fallback={<SectionSkeleton label="rates" />}>
              <RatePanel />
            </Suspense>
          </div>
        </section>

        <section className="mt-16" aria-labelledby="reputation-heading">
          <h2 id="reputation-heading" className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            Reputation
          </h2>
          <div className="mt-4">
            <Suspense fallback={<SectionSkeleton label="reputation" />}>
              <ReputationSection />
            </Suspense>
          </div>
        </section>
      </div>
    </main>
  );
}
