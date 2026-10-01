import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDetailRecord,
  type CorridorDetailRepository,
  type CorridorDirectoryRecord,
  type CorridorDirectoryRepository,
  type CorridorDirectoryRepositoryDependencies,
  type CorridorDetailRepositoryDependencies,
} from "@/lib/api/corridorRepository";
import { getDbForWorkload, PUBLIC_WORKLOAD } from "@/lib/db/workloadAccessor";
import { transferCapable } from "@/lib/stellar/anchors";
import type {
  CorridorApiResult,
  CorridorsApiResult,
  PublicCorridor,
  PublicCorridorAnchor,
  PublicCorridorDetail,
  PublicCorridorsResponse,
} from "@/types/api/corridors";

const CORRIDOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CORRIDOR_SLUG_LENGTH = 100;

export type CorridorsApiDependencies = Readonly<{
  repository?: CorridorDirectoryRepository;
  dbDependencies?: CorridorDirectoryRepositoryDependencies;
}>;

export type CorridorApiDependencies = Readonly<{
  repository?: CorridorDetailRepository;
  dbDependencies?: CorridorDetailRepositoryDependencies;
}>;

export function isValidCorridorSlug(slug: string): boolean {
  return slug.length > 0
    && slug.length <= MAX_CORRIDOR_SLUG_LENGTH
    && CORRIDOR_SLUG_PATTERN.test(slug);
}

async function getDirectoryRepositoryDependencies(
  dependencies: CorridorsApiDependencies = {},
): Promise<CorridorDirectoryRepositoryDependencies> {
  return {
    db: dependencies.dbDependencies?.db ?? getDbForWorkload(PUBLIC_WORKLOAD),
  };
}

async function getDetailRepositoryDependencies(
  dependencies: CorridorApiDependencies = {},
): Promise<CorridorDetailRepositoryDependencies> {
  return {
    db: dependencies.dbDependencies?.db ?? getDbForWorkload(PUBLIC_WORKLOAD),
  };
}

export async function getCorridorsApiResult(
  dependencies: CorridorsApiDependencies = {},
): Promise<CorridorsApiResult> {
  try {
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    const repoDeps = await getDirectoryRepositoryDependencies(dependencies);
    return Object.freeze({
      status: 200,
      body: serializeCorridors(await repository.findAll(repoDeps)),
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

export async function getCorridorApiResult(
  slug: string,
  dependencies: CorridorApiDependencies = {},
): Promise<CorridorApiResult> {
  if (!isValidCorridorSlug(slug)) {
    return errorResult(
      400,
      "invalid_corridor_slug",
      "A valid corridor slug is required.",
    );
  }

  try {
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    const repoDeps = await getDetailRepositoryDependencies(dependencies);
    const corridor = await repository.findBySlug(slug, repoDeps);

    if (!corridor) {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }

    return Object.freeze({
      status: 200,
      body: Object.freeze({ corridor: serializeCorridorDetail(corridor) }),
    });
  } catch {
    return errorResult(500, "internal_error", "Unable to load corridor.");
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

export function serializeCorridorDetail(
  record: CorridorDetailRecord,
): PublicCorridorDetail {
  const anchors = Object.freeze([...record.anchors]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((anchor) => {
      const seps = Object.freeze([...anchor.seps].sort((left, right) => left - right));
      return Object.freeze({
        slug: anchor.slug,
        name: anchor.name,
        homeDomain: anchor.homeDomain,
        status: anchor.status,
        seps,
        isTransferCapable: transferCapable(seps),
      }) satisfies PublicCorridorAnchor;
    }));

  return Object.freeze({
    slug: record.slug,
    sourceAsset: record.assetCodeFrom,
    sourceCountry: record.countryFrom,
    destinationAsset: record.assetCodeTo,
    destinationCountry: record.countryTo,
    anchorCount: anchors.length,
    anchors,
  });
}

function errorResult(
  status: 400 | 404 | 500,
  code: "invalid_corridor_slug" | "corridor_not_found" | "internal_error",
  message: string,
): CorridorApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}
