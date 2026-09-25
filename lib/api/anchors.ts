import {
  PRISMA_ANCHOR_DIRECTORY_REPOSITORY,
  type AnchorDetailRecord,
  type AnchorDirectoryRecord,
  type AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
import {
  NO_PAGINATION_QUERY,
  paginate,
  parsePagination,
  type PaginationQuery,
} from "@/lib/api/pagination";
import { transferCapable } from "@/lib/stellar/anchors";
import type {
  AnchorApiResult,
  AnchorsApiErrorResponse,
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
  dependencies: AnchorsApiDependencies = {},
  pagination: PaginationQuery = NO_PAGINATION_QUERY,
): Promise<AnchorsApiResult> {
  const parsed = parsePagination(pagination);
  if (!parsed.ok) {
    return Object.freeze({
      status: 400,
      body: errorBody("invalid_pagination", parsed.message),
    });
  }

  try {
    const repository = dependencies.repository
      ?? PRISMA_ANCHOR_DIRECTORY_REPOSITORY;
    const body = serializeAnchors(await repository.findAll());
    const anchors = paginate(body.anchors, parsed.pagination);

    return Object.freeze({
      status: 200,
      body: Object.freeze({ anchors, count: anchors.length }),
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

    return Object.freeze({
      status: 200,
      body: Object.freeze({ anchor: serializeAnchorDetail(anchor) }),
    });
  } catch {
    return internalError();
  }
}

export function serializeAnchors(
  records: readonly AnchorDirectoryRecord[],
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

  return Object.freeze({ anchors, count: anchors.length });
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

function errorBody(
  code: AnchorsApiErrorResponse["error"]["code"],
  message: string,
): AnchorsApiErrorResponse {
  return Object.freeze({ error: Object.freeze({ code, message }) });
}

function internalError(): Readonly<{
  status: 500;
  body: AnchorsApiErrorResponse;
}> {
  return Object.freeze({
    status: 500,
    body: errorBody("internal_error", "Unable to load anchors."),
  });
}
