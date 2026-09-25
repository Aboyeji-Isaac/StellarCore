import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDetailRecord,
  type CorridorDetailRepository,
  type CorridorDirectoryRecord,
  type CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import {
  NO_PAGINATION_QUERY,
  paginate,
  parsePagination,
  type PaginationQuery,
} from "@/lib/api/pagination";
import { transferCapable } from "@/lib/stellar/anchors";
import type {
  CorridorApiErrorResponse,
  CorridorApiResult,
  CorridorsApiErrorResponse,
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
}>;

export type CorridorApiDependencies = Readonly<{
  repository?: CorridorDetailRepository;
}>;

export function isValidCorridorSlug(slug: string): boolean {
  return slug.length > 0
    && slug.length <= MAX_CORRIDOR_SLUG_LENGTH
    && CORRIDOR_SLUG_PATTERN.test(slug);
}

export async function getCorridorsApiResult(
  dependencies: CorridorsApiDependencies = {},
  pagination: PaginationQuery = NO_PAGINATION_QUERY,
): Promise<CorridorsApiResult> {
  const parsed = parsePagination(pagination);
  if (!parsed.ok) {
    return listErrorResult(400, "invalid_pagination", parsed.message);
  }

  try {
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    const body = serializeCorridors(await repository.findAll());
    const corridors = paginate(body.corridors, parsed.pagination);

    return Object.freeze({
      status: 200,
      body: Object.freeze({ corridors, count: corridors.length }),
    });
  } catch {
    return listErrorResult(500, "internal_error", "Unable to load corridors.");
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
    const corridor = await repository.findBySlug(slug);

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
  code: CorridorApiErrorResponse["error"]["code"],
  message: string,
): CorridorApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}

function listErrorResult(
  status: 400 | 500,
  code: CorridorsApiErrorResponse["error"]["code"],
  message: string,
): CorridorsApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}
