import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDetailRecord,
  type CorridorDetailRepository,
  type CorridorDirectoryRecord,
  type CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import { isRequestCancellationError } from "@/lib/api/requestContext";
import { transferCapable } from "@/lib/stellar/anchors";
import type {
  CorridorApiResult,
  CorridorsApiResult,
  PublicCorridor,
  PublicCorridorAnchor,
  PublicCorridorDetail,
  PublicCorridorsResponse,
} from "@/types/api/corridors";
import type { RequestContext } from "@/types/api/requestContext";

const CORRIDOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CORRIDOR_SLUG_LENGTH = 100;

export type CorridorsApiDependencies = Readonly<{
  repository?: CorridorDirectoryRepository;
  context?: RequestContext;
}>;

export type CorridorApiDependencies = Readonly<{
  repository?: CorridorDetailRepository;
  context?: RequestContext;
}>;

export function isValidCorridorSlug(slug: string): boolean {
  return slug.length > 0
    && slug.length <= MAX_CORRIDOR_SLUG_LENGTH
    && CORRIDOR_SLUG_PATTERN.test(slug);
}

export async function getCorridorsApiResult(
  dependencies: CorridorsApiDependencies = {},
): Promise<CorridorsApiResult> {
  const { context } = dependencies;

  try {
    context?.assertActive();
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    const records = await repository.findAll(context);
    context?.assertActive();
    return Object.freeze({
      status: 200,
      body: serializeCorridors(records),
    });
  } catch (error) {
    if (isRequestCancellationError(error)) throw error;
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

  const { context } = dependencies;

  try {
    context?.assertActive();
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;
    const corridor = await repository.findBySlug(slug, context);
    context?.assertActive();

    if (!corridor) {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }

    return Object.freeze({
      status: 200,
      body: Object.freeze({ corridor: serializeCorridorDetail(corridor) }),
    });
  } catch (error) {
    if (isRequestCancellationError(error)) throw error;
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
