import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDirectoryRecord,
  type CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import type {
  CorridorsApiResult,
  PublicCorridor,
  PublicCorridorsResponse,
} from "@/types/api/corridors";

export type CorridorsApiDependencies = Readonly<{
  repository?: CorridorDirectoryRepository;
}>;

export async function getCorridorsApiResult(
  dependencies: CorridorsApiDependencies = {},
): Promise<CorridorsApiResult> {
  try {
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    return Object.freeze({
      status: 200,
      body: serializeCorridors(await repository.findAll()),
    });
  } catch {
    return Object.freeze({
      status: 500,
      body: Object.freeze({
        error: Object.freeze({
          code: "internal_error",
          message: "Unable to load corridors.",
        }),
      }),
    });
  }
}

export function serializeCorridors(
  records: readonly CorridorDirectoryRecord[],
): PublicCorridorsResponse {
  const corridors = Object.freeze([...records]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((record) => Object.freeze({
      slug: record.slug,
      sourceAsset: record.assetCodeFrom,
      sourceCountry: record.countryFrom,
      destinationAsset: record.assetCodeTo,
      destinationCountry: record.countryTo,
      anchorCount: record.anchorCount,
    }) satisfies PublicCorridor));

  return Object.freeze({ corridors, count: corridors.length });
}

