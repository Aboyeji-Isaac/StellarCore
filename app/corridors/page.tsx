import type { Metadata } from "next";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import { CorridorDirectory } from "@/components/corridors/CorridorDirectory";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Corridors — StellarCore",
  description: "Directory of reviewed corridors with a client-side search.",
};

export default async function CorridorsPage() {
  const result = await getCorridorsApiResult();

  if (result.status !== 200) {
    return (
      <main id="main-content" className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12">
        <div className="mx-auto max-w-6xl">
          <p className="rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
            {result.body.error.message}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <header className="max-w-3xl">
          <p className="eyebrow">Public evidence console</p>
          <h1 className="mt-2 text-3xl leading-tight sm:text-4xl" style={{ fontFamily: "var(--display)" }}>
            Corridor directory
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            Search reviewed corridors by source or destination asset code, or by source or destination
            country. Filtering is immediate and never triggers a reload.
          </p>
        </header>
        <CorridorDirectory corridors={result.body.corridors} />
      </div>
    </main>
  );
}