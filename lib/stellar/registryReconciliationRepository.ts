import type { PersistedReconciliationState } from "@/types/registryReconciliation";

/**
 * Read-only database projection for reconciliation. Mirrors the repository
 * pattern used by the public API read models: the pure auditor never imports
 * Prisma; this adapter translates persisted rows into natural-key records
 * with historical-evidence counts. It performs no writes.
 */
export type RegistryReconciliationRepository = Readonly<{
  loadPersistedState: () => Promise<PersistedReconciliationState>;
}>;

export const PRISMA_REGISTRY_RECONCILIATION_REPOSITORY =
  Object.freeze<RegistryReconciliationRepository>({
    async loadPersistedState(): Promise<PersistedReconciliationState> {
      const { db } = await import("@/lib/dbClient");

      const [anchors, corridors, associations] = await Promise.all([
        db.anchor.findMany({
          orderBy: { slug: "asc" },
          select: {
            slug: true,
            name: true,
            homeDomain: true,
            tomlUrl: true,
            status: true,
            _count: {
              select: {
                corridors: true,
                rateSnapshots: true,
                transferOutcomes: true,
              },
            },
          },
        }),
        db.corridor.findMany({
          orderBy: { slug: "asc" },
          select: {
            slug: true,
            assetCodeFrom: true,
            countryFrom: true,
            assetCodeTo: true,
            countryTo: true,
            _count: {
              select: {
                anchors: true,
                rateSnapshots: true,
                transferOutcomes: true,
              },
            },
          },
        }),
        db.anchorCorridor.findMany({
          orderBy: [
            { anchor: { slug: "asc" } },
            { corridor: { slug: "asc" } },
          ],
          select: {
            anchor: { select: { slug: true } },
            corridor: { select: { slug: true } },
          },
        }),
      ]);

      return Object.freeze({
        anchors: Object.freeze(anchors.map((anchor) => Object.freeze({
          slug: anchor.slug,
          name: anchor.name,
          homeDomain: anchor.homeDomain,
          tomlUrl: anchor.tomlUrl,
          status: anchor.status,
          corridorCount: anchor._count.corridors,
          rateSnapshotCount: anchor._count.rateSnapshots,
          transferOutcomeCount: anchor._count.transferOutcomes,
        }))),
        corridors: Object.freeze(corridors.map((corridor) => Object.freeze({
          slug: corridor.slug,
          assetCodeFrom: corridor.assetCodeFrom,
          countryFrom: corridor.countryFrom,
          assetCodeTo: corridor.assetCodeTo,
          countryTo: corridor.countryTo,
          anchorCount: corridor._count.anchors,
          rateSnapshotCount: corridor._count.rateSnapshots,
          transferOutcomeCount: corridor._count.transferOutcomes,
        }))),
        associations: Object.freeze(associations.map((association) => Object.freeze({
          anchorSlug: association.anchor?.slug ?? "",
          corridorSlug: association.corridor?.slug ?? "",
        }))),
      });
    },
  });
