export type CorridorDirectoryRecord = Readonly<{
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
  anchorCount: number;
}>;

export type CorridorDirectoryRepository = Readonly<{
  findAll: () => Promise<readonly CorridorDirectoryRecord[]>;
}>;

export const PRISMA_CORRIDOR_DIRECTORY_REPOSITORY = Object.freeze({
  async findAll(): Promise<readonly CorridorDirectoryRecord[]> {
    const { db } = await import("@/lib/dbClient");
    const corridors = await db.corridor.findMany({
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        assetCodeFrom: true,
        countryFrom: true,
        assetCodeTo: true,
        countryTo: true,
        _count: { select: { anchors: true } },
      },
    });

    return Object.freeze(corridors.map((corridor) => Object.freeze({
      slug: corridor.slug,
      assetCodeFrom: corridor.assetCodeFrom,
      countryFrom: corridor.countryFrom,
      assetCodeTo: corridor.assetCodeTo,
      countryTo: corridor.countryTo,
      anchorCount: corridor._count.anchors,
    })));
  },
}) satisfies CorridorDirectoryRepository;

