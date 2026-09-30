import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDetailRecord,
  type CorridorDetailRepository,
  type CorridorDirectoryRecord,
  type CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import {
  measureResponseBytes,
  responseTooLargeError,
  RESPONSE_BUDGETS,
} from "@/lib/api/responseSizeEnforcer";
import { transferCapable } from "@/lib/stellar/anchors";
import {
  decodeCursor,
  paginate,
  validatePaginationParams,
} from "@/types/pagination";
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
  limit: number | null = null,
  after: string | null = null,
  dependencies: CorridorsApiDependencies = {},
): Promise<CorridorsApiResult> {
  try {
    const repository = dependencies.repository
      ?? PRISMA_CORRIDOR_DIRECTORY_REPOSITORY;

    const allCorridors = await repository.findAll();
    const pagination = validatePaginationParams(limit, after, 500);
    const decodedCursor = pagination.after ? decodeCursor(pagination.after) : null;

    if (pagination.after && !decodedCursor) {
      return Object.freeze({
        status: 400,
        body: Object.freeze({
          error: Object.freeze({
            code: "invalid_pagination_cursor",
            message: "The pagination cursor is invalid.",
          }),
        }),
      });
    }

    const paginated = paginate(allCorridors, {
      limit: pagination.limit,
      after: decodedCursor,
    });

    const body = serializeCorridors(paginated.items, paginated.next, pagination.limit);
    const responseBytes = measureResponseBytes(body);

    if (responseBytes > RESPONSE_BUDGETS.corridors.maxBytes) {
      return responseTooLargeError() as CorridorsApiResult;
    }

    return Object.freeze({
      status: 200,
      body,
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
    const corridor = await repository.findBySlug(slug);

    if (!corridor) {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }

    const body = Object.freeze({ corridor: serializeCorridorDetail(corridor) });
    const responseBytes = measureResponseBytes(body);

    if (responseBytes > RESPONSE_BUDGETS.corridorDetail.maxBytes) {
      return responseTooLargeError() as CorridorApiResult;
    }

    return Object.freeze({
      status: 200,
      body,
    });
  } catch {
    return errorResult(500, "internal_error", "Unable to load corridor.");
  }
}

export function serializeCorridors(
  records: readonly CorridorDirectoryRecord[],
  nextCursor: string | null = null,
  limit: number = 100,
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

  return Object.freeze({
    corridors,
    count: corridors.length,
    limit,
    ...(nextCursor ? { next: nextCursor } : {}),
  });
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
