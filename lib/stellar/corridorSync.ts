import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

export type PersistedCorridor = CorridorRegistryEntry;

export type AnchorCorridorAssociationResult = Readonly<{
  anchorSlug: string;
  corridorSlugs: readonly string[];
  associationCount: number;
  staleAssociationsRemoved: number;
}>;

export type CorridorSyncFailureCode =
  | "CORRIDOR_PERSISTENCE_FAILURE"
  | "ANCHOR_NOT_FOUND"
  | "CORRIDOR_NOT_FOUND"
  | "UNEXPECTED_ERROR";

export type CorridorSyncFailure = Readonly<{
  scope: "CORRIDOR" | "ASSOCIATION";
  slug: string;
  code: CorridorSyncFailureCode;
}>;

export type CorridorSyncResult = Readonly<{
  totalCorridorsAttempted: number;
  corridorsSynchronized: number;
  totalAssociations: number;
  successfulCorridorSlugs: readonly string[];
  associationResults: readonly AnchorCorridorAssociationResult[];
  failures: readonly CorridorSyncFailure[];
}>;

export type CorridorSyncDependencies = Readonly<{
  upsertCorridor: (corridor: CorridorRegistryEntry) => Promise<PersistedCorridor>;
  syncAssociations: (
    mapping: AnchorCorridorRegistryEntry,
  ) => Promise<AnchorCorridorAssociationResult>;
}>;

type AssociationErrorCode = Extract<
  CorridorSyncFailureCode,
  "ANCHOR_NOT_FOUND" | "CORRIDOR_NOT_FOUND"
>;

export class CorridorAssociationError extends Error {
  constructor(readonly code: AssociationErrorCode) {
    super(code === "ANCHOR_NOT_FOUND" ? "Anchor not found" : "Corridor not found");
    this.name = "CorridorAssociationError";
  }
}

const CORRIDOR_SELECT = {
  slug: true,
  assetCodeFrom: true,
  countryFrom: true,
  assetCodeTo: true,
  countryTo: true,
} as const;

export async function persistCorridor(
  corridor: CorridorRegistryEntry,
): Promise<PersistedCorridor> {
  const { db } = await import("@/lib/db");
  const data = {
    assetCodeFrom: corridor.assetCodeFrom,
    countryFrom: corridor.countryFrom,
    assetCodeTo: corridor.assetCodeTo,
    countryTo: corridor.countryTo,
  };

  const persisted = await db.corridor.upsert({
    where: { slug: corridor.slug },
    create: { slug: corridor.slug, ...data },
    update: data,
    select: CORRIDOR_SELECT,
  });

  return Object.freeze(persisted);
}

export async function persistAnchorCorridorAssociations(
  mapping: AnchorCorridorRegistryEntry,
): Promise<AnchorCorridorAssociationResult> {
  const { db } = await import("@/lib/db");

  return db.$transaction(async (transaction) => {
    const anchor = await transaction.anchor.findUnique({
      where: { slug: mapping.anchorSlug },
      select: { id: true },
    });

    if (!anchor) {
      throw new CorridorAssociationError("ANCHOR_NOT_FOUND");
    }

    const corridors = await transaction.corridor.findMany({
      where: { slug: { in: [...mapping.corridorSlugs] } },
      select: { id: true, slug: true },
    });
    const corridorIdsBySlug = new Map(
      corridors.map((corridor) => [corridor.slug, corridor.id]),
    );
    const corridorIds = mapping.corridorSlugs.map((slug) =>
      corridorIdsBySlug.get(slug),
    );

    if (corridorIds.some((id) => id === undefined)) {
      throw new CorridorAssociationError("CORRIDOR_NOT_FOUND");
    }

    const desiredCorridorIds = corridorIds as string[];
    const removed = await transaction.anchorCorridor.deleteMany({
      where: {
        anchorId: anchor.id,
        corridorId: { notIn: desiredCorridorIds },
      },
    });

    await transaction.anchorCorridor.createMany({
      data: desiredCorridorIds.map((corridorId) => ({
        anchorId: anchor.id,
        corridorId,
      })),
      skipDuplicates: true,
    });

    const associationCount = await transaction.anchorCorridor.count({
      where: { anchorId: anchor.id },
    });

    return freezeAssociationResult({
      anchorSlug: mapping.anchorSlug,
      corridorSlugs: mapping.corridorSlugs,
      associationCount,
      staleAssociationsRemoved: removed.count,
    });
  });
}

export async function syncCorridorRegistry(
  corridors: readonly CorridorRegistryEntry[] = CORRIDOR_REGISTRY,
  mappings: readonly AnchorCorridorRegistryEntry[] = ANCHOR_CORRIDOR_REGISTRY,
  dependencies: CorridorSyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
): Promise<CorridorSyncResult> {
  const successfulCorridorSlugs: string[] = [];
  const associationResults: AnchorCorridorAssociationResult[] = [];
  const failures: CorridorSyncFailure[] = [];

  for (const corridor of corridors) {
    try {
      await dependencies.upsertCorridor(corridor);
      successfulCorridorSlugs.push(corridor.slug);
    } catch {
      failures.push(
        Object.freeze({
          scope: "CORRIDOR",
          slug: corridor.slug,
          code: "CORRIDOR_PERSISTENCE_FAILURE",
        }),
      );
    }
  }

  for (const mapping of mappings) {
    try {
      associationResults.push(
        freezeAssociationResult(await dependencies.syncAssociations(mapping)),
      );
    } catch (error) {
      failures.push(
        Object.freeze({
          scope: "ASSOCIATION",
          slug: mapping.anchorSlug,
          code: classifyAssociationFailure(error),
        }),
      );
    }
  }

  return Object.freeze({
    totalCorridorsAttempted: corridors.length,
    corridorsSynchronized: successfulCorridorSlugs.length,
    totalAssociations: associationResults.reduce(
      (total, result) => total + result.associationCount,
      0,
    ),
    successfulCorridorSlugs: Object.freeze(successfulCorridorSlugs),
    associationResults: Object.freeze(associationResults),
    failures: Object.freeze(failures),
  });
}

const DEFAULT_SYNC_DEPENDENCIES = Object.freeze({
  upsertCorridor: persistCorridor,
  syncAssociations: persistAnchorCorridorAssociations,
}) satisfies CorridorSyncDependencies;

function classifyAssociationFailure(error: unknown): CorridorSyncFailureCode {
  return error instanceof CorridorAssociationError
    ? error.code
    : "UNEXPECTED_ERROR";
}

function freezeAssociationResult(
  result: AnchorCorridorAssociationResult,
): AnchorCorridorAssociationResult {
  return Object.freeze({
    ...result,
    corridorSlugs: Object.freeze([...result.corridorSlugs]),
  });
}
