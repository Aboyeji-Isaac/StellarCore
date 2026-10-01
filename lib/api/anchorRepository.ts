import { PrismaClient } from "@/app/generated/prisma/client";
import { getDbForWorkload, PUBLIC_WORKLOAD } from "@/lib/db/workloadAccessor";
import type { PublicAnchorStatus } from "@/types/api/anchors";

export type AnchorDirectoryRecord = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  status: PublicAnchorStatus;
  seps: readonly number[];
  corridorCount: number;
}>;

export type AnchorDetailRecord = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  status: PublicAnchorStatus;
  seps: readonly number[];
  corridors: readonly Readonly<{
    slug: string;
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
  }>[];
}>;

export type AnchorDirectoryRepository = Readonly<{
  findAll: (deps?: AnchorDirectoryRepositoryDependencies) => Promise<readonly AnchorDirectoryRecord[]>;
  findBySlug: (slug: string, deps?: AnchorDirectoryRepositoryDependencies) => Promise<AnchorDetailRecord | null>;
}>;

export type AnchorDirectoryRepositoryDependencies = Readonly<{
  db?: PrismaClient;
}>;

async function getDb(dependencies: AnchorDirectoryRepositoryDependencies = {}): Promise<PrismaClient> {
  return dependencies.db ?? getDbForWorkload(PUBLIC_WORKLOAD);
}

export const PRISMA_ANCHOR_DIRECTORY_REPOSITORY: AnchorDirectoryRepository = Object.freeze({
  async findAll(dependencies: AnchorDirectoryRepositoryDependencies = {}): Promise<readonly AnchorDirectoryRecord[]> {
    const db = await getDb(dependencies);
    const anchors = await db.anchor.findMany({
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        name: true,
        homeDomain: true,
        status: true,
        seps: true,
        _count: { select: { corridors: true } },
      },
    });

    return Object.freeze(anchors.map((anchor) => Object.freeze({
      slug: anchor.slug,
      name: anchor.name,
      homeDomain: anchor.homeDomain,
      status: anchor.status,
      seps: Object.freeze([...anchor.seps]),
      corridorCount: anchor._count.corridors,
    })));
  },

  async findBySlug(slug: string, dependencies: AnchorDirectoryRepositoryDependencies = {}): Promise<AnchorDetailRecord | null> {
    const db = await getDb(dependencies);
    const anchor = await db.anchor.findUnique({
      where: { slug },
      select: {
        slug: true,
        name: true,
        homeDomain: true,
        status: true,
        seps: true,
        corridors: {
          orderBy: { corridor: { slug: "asc" } },
          select: {
            corridor: {
              select: {
                slug: true,
                assetCodeFrom: true,
                countryFrom: true,
                assetCodeTo: true,
                countryTo: true,
              },
            },
          },
        },
      },
    });

    if (!anchor) return null;

    return Object.freeze({
      slug: anchor.slug,
      name: anchor.name,
      homeDomain: anchor.homeDomain,
      status: anchor.status,
      seps: Object.freeze([...anchor.seps]),
      corridors: Object.freeze(anchor.corridors.map(({ corridor }) =>
        Object.freeze({ ...corridor }))),
    });
  },
}) satisfies AnchorDirectoryRepository;
