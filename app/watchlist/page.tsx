"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getAnchorsApiResult } from "@/lib/api/anchors";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import type { PublicAnchorSummary } from "@/types/api/anchors";
import type { PublicCorridor } from "@/types/api/corridors";
import { createWatchlistStore, type WatchlistItem } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

function WatchlistPage() {
  const pathname = usePathname();

  const [anchors, setAnchors] = useState<readonly PublicAnchorSummary[]>([]);
  const [corridors, setCorridors] = useState<readonly PublicCorridor[]>([]);
  const [watchlist, setWatchlist] = useState<ReturnType<typeof createWatchlistStore>>(
    createWatchlistStore(),
  );

  // Load available anchors and corridors from the API
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      const anchorsResult = await getAnchorsApiResult();
      const corridorsResult = await getCorridorsApiResult();

      if (!cancelled) {
        if (anchorsResult.status === 200) {
          setAnchors(anchorsResult.body.anchors);
        }
        if (corridorsResult.status === 200) {
          setCorridors(corridorsResult.body.corridors);
        }
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const anchorOptions = anchors.map((anchor) => ({
    id: `anchor-${anchor.slug}`,
    type: "anchor" as const,
    slug: anchor.slug,
    name: anchor.name,
  }));

  const corridorOptions = corridors.map((corridor) => ({
    id: `corridor-${corridor.slug}`,
    type: "corridor" as const,
    slug: corridor.slug,
    name: `${corridor.sourceAsset} → ${corridor.destinationAsset}`,
  }));

  const handleAdd = (item: WatchlistItem) => {
    setWatchlist((prev) => prev.add(item));
  };

  const handleRemove = (slug: string) => {
    setWatchlist((prev) => prev.remove(slug));
  };

  const watchlistItems = watchlist.items;

  return (
    <div className="min-h-screen bg-[var(--black)] px-4 py-8 text-[var(--white)] sm:px-8 sm:py-10 lg:px-12">
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] mb-6">
        <Link href="/dashboard" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]">Dashboard</Link>
        <span aria-hidden="true" className="px-2">/</span>
        <span className="text-lg" aria-current="page">Watchlist</span>
      </nav>

      <header className="max-w-3xl">
        <p className="eyebrow">Personal watchlist</p>
        <h1 className="mt-2 text-3xl leading-tight sm:text-4xl" style={{ fontFamily: "var(--display)" }}>
          My anchors & corridors
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
          Save anchor and corridor slugs for quick revisiting. This is a bookmark list only — no
          automatic monitoring, alerts, or background synchronization.
        </p>
      </header>

      {/* Watchlist summary */}
      <section className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6">
        <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-4">
          {watchlistItems.length} {watchlistItems.length === 1 ? "bookmark" : "bookmarks"}
        </h2>

        {watchlistItems.length === 0 ? (
          <p className="text-[var(--muted)]">
            No bookmarks yet. Select anchors or corridors below to add them.
          </p>
        ) : (
          <ul className="space-y-3 text-[var(--muted)]">
            {watchlistItems.map((item) => (
              <li key={item.id} className="flex items-center gap-3">
                <span className="font-medium">{item.name}</span>
                <button
                  onClick={() => handleRemove(item.slug)}
                  className="text-[var(--muted)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] text-xs"
                  aria-label={`Remove ${item.name} from watchlist`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {watchlistItems.length === 0 && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Items persist only in this browser. Clearing browsing data will remove them.
          </p>
        )}
      </section>

      {/* Add anchors section */}
      <section className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6">
        <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-4">
          Add anchors
        </h2>

        <p className="text-xs text-[var(--muted)] mb-4">
          Select anchors from the public list below to bookmark.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ghost)] text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 text-right font-medium">Slug</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {anchorOptions.map((option) => (
                <tr
                  key={option.id}
                  className="border-b border-[var(--ghost)] last:border-0"
                >
                  <td className="px-4 py-3 text-[var(--white)]">
                    {option.name}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {option.slug}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--muted)]">
                    {option.slug}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleAdd(option)}
                      className="text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] text-sm"
                      aria-label={`Add ${option.name} to watchlist`}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Add corridors section */}
      <section className="mt-8 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-6">
        <h2 className="text-xs uppercase tracking-wide text-[var(--muted)] mb-4">
          Add corridors
        </h2>

        <p className="text-xs text-[var(--muted)] mb-4">
          Select corridors from the public list below to bookmark.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ghost)] text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Destination</th>
                <th className="px-4 py-3 text-right font-medium">Slug</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {corridorOptions.map((option) => (
                <tr
                  key={option.id}
                  className="border-b border-[var(--ghost)] last:border-0"
                >
                  <td className="px-4 py-3 text-[var(--white)]">
                    {option.name}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {option.slug}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--muted)]">
                    {option.slug}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleAdd(option)}
                      className="text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)] text-sm"
                      aria-label={`Add ${option.name} to watchlist`}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default WatchlistPage;