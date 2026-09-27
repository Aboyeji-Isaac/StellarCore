import type { Metadata } from "next";
import { getAnchorsApiResult } from "@/lib/api/anchors";
import { AnchorDirectory } from "@/components/anchors/AnchorDirectory";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anchors — StellarCore",
  description: "Directory of synchronized Stellar anchors with a client-side SEP-support filter.",
};

export default async function AnchorsPage() {
  const result = await getAnchorsApiResult();

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
            Anchor directory
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            Filter persisted anchors by advertised SEP support. Selecting multiple SEPs shows anchors
            advertising at least one of them. Status describes persisted synchronization state, not current
            availability.
          </p>
        </header>
        <AnchorDirectory anchors={result.body.anchors} />
      </div>
    </main>
  );
}