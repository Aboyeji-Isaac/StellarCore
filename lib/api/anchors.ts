import {
  PRISMA_ANCHOR_DIRECTORY_REPOSITORY,
  type AnchorDetailRecord,
  type AnchorDirectoryRecord,
  type AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
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
  AnchorApiResult,
  AnchorsApiResult,
  PublicAnchorCorridor,
  PublicAnchorDetail,
  PublicAnchorSummary,
  PublicAnchorsResponse,
} from "@/types/api/anchors";

const ANCHOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ANCHOR_SLUG_LENGTH = 100;

export type AnchorsApiDependencies = Readonly<{
  repository?: AnchorDirectoryRepository;
}>;

export function isValidAnchorSlug(slug: string): boolean {
  return slug.length > 0
    && slug.length <= MAX_ANCHOR_SLUG_LENGTH
    && ANCHOR_SLUG_PATTERN.test(slug);
}

export async function getAnchorsApiResult(
  limit: number | null = null,
  after: string | null = null,
  dependencies: AnchorsApiDependencies = {},
): Promise<AnchorsApiResult> {
  try {
    const repository = dependencies.repository
      ?? PRISMA_ANCHOR_DIRECTORY_REPOSITORY;

    const allAnchors = await repository.findAll();
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

    const paginated = paginate(allAnchors, {
      limit: pagination.limit,
      after: decodedCursor,
    });

    const body = serializeAnchors(paginated.items, paginated.next, pagination.limit);
    const responseBytes = measureResponseBytes(body);

    if (responseBytes > RESPONSE_BUDGETS.anchors.maxBytes) {
      return responseTooLargeError() as AnchorsApiResult;
    }

    return Object.freeze({
      status: 200,
      body,
    });
  } catch {
    return internalError();
  }
}

export async function getAnchorApiResult(
  slug: string,
  dependencies: AnchorsApiDependencies = {},
): Promise<AnchorApiResult> {
  if (!isValidAnchorSlug(slug)) {
    return Object.freeze({
      status: 400,
      body: Object.freeze({
        error: Object.freeze({
          code: "invalid_anchor_slug",
          message: "A valid anchor slug is required.",
        }),
      }),
    });
  }

  try {
    const repository = dependencies.repository
      ?? PRISMA_ANCHOR_DIRECTORY_REPOSITORY;
    const anchor = await repository.findBySlug(slug);
    if (!anchor) {
      return Object.freeze({
        status: 404,
        body: Object.freeze({
          error: Object.freeze({
            code: "anchor_not_found",
            message: "Anchor not found.",
          }),
        }),
      });
    }

    const body = Object.freeze({ anchor: serializeAnchorDetail(anchor) });
    const responseBytes = measureResponseBytes(body);

    if (responseBytes > RESPONSE_BUDGETS.anchorDetail.maxBytes) {
      return responseTooLargeError() as AnchorApiResult;
    }

    return Object.freeze({
      status: 200,
      body,
    });
  } catch {
    return internalError();
  }
}

export function serializeAnchors(
  records: readonly AnchorDirectoryRecord[],
  nextCursor: string | null = null,
  limit: number = 100,
): PublicAnchorsResponse {
  const anchors = Object.freeze([...records]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((record) => {
      const seps = sortedSeps(record.seps);
      return Object.freeze({
        slug: record.slug,
        name: record.name,
        homeDomain: record.homeDomain,
        status: record.status,
        seps,
        isTransferCapable: transferCapable(seps),
        corridorCount: record.corridorCount,
      }) satisfies PublicAnchorSummary;
    }));

  return Object.freeze({
    anchors,
    count: anchors.length,
    limit,
    ...(nextCursor ? { next: nextCursor } : {}),
  });
}

export function serializeAnchorDetail(
  record: AnchorDetailRecord,
): PublicAnchorDetail {
  const seps = sortedSeps(record.seps);
  const corridors = Object.freeze([...record.corridors]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((corridor) => Object.freeze({
      slug: corridor.slug,
      sourceAsset: corridor.assetCodeFrom,
      sourceCountry: corridor.countryFrom,
      destinationAsset: corridor.assetCodeTo,
      destinationCountry: corridor.countryTo,
    }) satisfies PublicAnchorCorridor));

  return Object.freeze({
    slug: record.slug,
    name: record.name,
    homeDomain: record.homeDomain,
    status: record.status,
    seps,
    isTransferCapable: transferCapable(seps),
    corridors,
  });
}

function sortedSeps(seps: readonly number[]): readonly number[] {
  return Object.freeze([...seps].sort((left, right) => left - right));
}

function internalError(): Readonly<{
  status: 500;
  body: Readonly<{
    error: Readonly<{ code: "internal_error"; message: string }>;
  }>;
}> {
  return Object.freeze({
    status: 500,
    body: Object.freeze({
      error: Object.freeze({
        code: "internal_error",
        message: "Unable to load anchors.",
      }),
    }),
  });
}
