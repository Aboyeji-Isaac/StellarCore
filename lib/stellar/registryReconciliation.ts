import { AnchorStatus } from "@/app/generated/prisma/enums";
import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import { validateAnchorRegistry } from "@/lib/stellar/anchorRegistry";
import {
  validateAnchorCorridorRegistry,
  validateCorridorRegistry,
} from "@/lib/stellar/corridorRegistry";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

export const REGISTRY_RETIREMENT_REASON = "removed_from_reviewed_registry";

type ExistingEntity = Readonly<{ slug: string; registryActive: boolean; signature?: string }>;
type ExistingMapping = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  registryActive: boolean;
}>;

export type LifecycleChanges = Readonly<{
  activated: readonly string[];
  updated: readonly string[];
  retired: readonly string[];
  reactivated: readonly string[];
  unchanged: readonly string[];
}>;

export type RegistryReconciliationSummary = Readonly<{
  mode: "DRY_RUN" | "APPLIED";
  anchors: LifecycleChanges;
  corridors: LifecycleChanges;
  associations: LifecycleChanges;
}>;

export type RegistrySnapshot = Readonly<{
  anchors: readonly ExistingEntity[];
  corridors: readonly ExistingEntity[];
  associations: readonly ExistingMapping[];
}>;

export function planRegistryReconciliation(
  snapshot: RegistrySnapshot,
  anchors: readonly AnchorRegistryEntry[],
  corridors: readonly CorridorRegistryEntry[],
  mappings: readonly AnchorCorridorRegistryEntry[],
): Omit<RegistryReconciliationSummary, "mode"> {
  const anchorChanges = planEntities(snapshot.anchors, anchors.map((entry) => ({ slug: entry.slug, signature: anchorSignature(entry) })));
  const corridorChanges = planEntities(snapshot.corridors, corridors.map((entry) => ({ slug: entry.slug, signature: corridorSignature(entry) })));
  const desiredMappings = mappings.flatMap(({ anchorSlug, corridorSlugs }) =>
    corridorSlugs.map((corridorSlug) => mappingKey(anchorSlug, corridorSlug)));
  const existingMappings = snapshot.associations.map((mapping) => ({
    slug: mappingKey(mapping.anchorSlug, mapping.corridorSlug),
    registryActive: mapping.registryActive,
  }));

  return Object.freeze({
    anchors: anchorChanges,
    corridors: corridorChanges,
    associations: planEntities(existingMappings, desiredMappings.map((slug) => ({ slug }))),
  });
}

export async function reconcileReviewedRegistry(options: Readonly<{
  anchors?: readonly AnchorRegistryEntry[];
  corridors?: readonly CorridorRegistryEntry[];
  mappings?: readonly AnchorCorridorRegistryEntry[];
  dryRun?: boolean;
  now?: Date;
}> = {}): Promise<RegistryReconciliationSummary> {
  const anchors = options.anchors ?? ANCHOR_REGISTRY;
  const corridors = options.corridors ?? CORRIDOR_REGISTRY;
  const mappings = options.mappings ?? ANCHOR_CORRIDOR_REGISTRY;
  const now = options.now ?? new Date();

  // This gate deliberately precedes even the first database read. A partial or
  // malformed source can therefore never be interpreted as a retirement list.
  validateAnchorRegistry(anchors);
  validateCorridorRegistry(corridors);
  validateAnchorCorridorRegistry(mappings, corridors, anchors);

  const { db } = await import("@/lib/dbClient");

  return db.$transaction(async (transaction) => {
    const [storedAnchors, storedCorridors, storedAssociations] = await Promise.all([
      transaction.anchor.findMany({
        select: { slug: true, name: true, homeDomain: true, registryActive: true },
      }),
      transaction.corridor.findMany({
        select: { slug: true, assetCodeFrom: true, countryFrom: true, assetCodeTo: true, countryTo: true, registryActive: true },
      }),
      transaction.anchorCorridor.findMany({
        select: {
          registryActive: true,
          anchor: { select: { id: true, slug: true } },
          corridor: { select: { id: true, slug: true } },
        },
      }),
    ]);
    const snapshot: RegistrySnapshot = {
      anchors: storedAnchors.map((entry) => ({ ...entry, signature: anchorSignature(entry) })),
      corridors: storedCorridors.map((entry) => ({ ...entry, signature: corridorSignature(entry) })),
      associations: storedAssociations.map((association) => ({
        anchorSlug: association.anchor.slug,
        corridorSlug: association.corridor.slug,
        registryActive: association.registryActive,
      })),
    };
    const changes = planRegistryReconciliation(snapshot, anchors, corridors, mappings);

    if (options.dryRun) {
      return freezeSummary("DRY_RUN", changes);
    }

    const anchorBySlug = new Map(anchors.map((anchor) => [anchor.slug, anchor]));
    for (const slug of [...changes.anchors.activated, ...changes.anchors.updated, ...changes.anchors.reactivated]) {
      const anchor = anchorBySlug.get(slug)!;
      await transaction.anchor.upsert({
        where: { slug },
        create: {
          slug,
          name: anchor.name,
          homeDomain: anchor.homeDomain,
          tomlUrl: `https://${anchor.homeDomain}/.well-known/stellar.toml`,
          status: AnchorStatus.UNKNOWN,
          registryActive: true,
          registryActivatedAt: now,
        },
        update: {
          name: anchor.name,
          homeDomain: anchor.homeDomain,
          registryActive: true,
          registryActivatedAt: changes.anchors.reactivated.includes(slug) ? now : undefined,
          registryRetiredAt: null,
          registryRetirementReason: null,
        },
      });
    }
    await transaction.anchor.updateMany({
      where: { slug: { in: [...changes.anchors.retired] } },
      data: {
        registryActive: false,
        registryRetiredAt: now,
        registryRetirementReason: REGISTRY_RETIREMENT_REASON,
      },
    });

    const corridorBySlug = new Map(corridors.map((corridor) => [corridor.slug, corridor]));
    for (const slug of [...changes.corridors.activated, ...changes.corridors.updated, ...changes.corridors.reactivated]) {
      const corridor = corridorBySlug.get(slug)!;
      await transaction.corridor.upsert({
        where: { slug },
        create: { ...corridor, registryActive: true, registryActivatedAt: now },
        update: {
          assetCodeFrom: corridor.assetCodeFrom,
          countryFrom: corridor.countryFrom,
          assetCodeTo: corridor.assetCodeTo,
          countryTo: corridor.countryTo,
          registryActive: true,
          registryActivatedAt: changes.corridors.reactivated.includes(slug) ? now : undefined,
          registryRetiredAt: null,
          registryRetirementReason: null,
        },
      });
    }
    await transaction.corridor.updateMany({
      where: { slug: { in: [...changes.corridors.retired] } },
      data: {
        registryActive: false,
        registryRetiredAt: now,
        registryRetirementReason: REGISTRY_RETIREMENT_REASON,
      },
    });

    const activeAnchors = await transaction.anchor.findMany({
      where: { slug: { in: anchors.map(({ slug }) => slug) } },
      select: { id: true, slug: true },
    });
    const activeCorridors = await transaction.corridor.findMany({
      where: { slug: { in: corridors.map(({ slug }) => slug) } },
      select: { id: true, slug: true },
    });
    const anchorIds = new Map(activeAnchors.map(({ id, slug }) => [slug, id]));
    const corridorIds = new Map(activeCorridors.map(({ id, slug }) => [slug, id]));

    for (const key of [...changes.associations.activated, ...changes.associations.reactivated]) {
      const [anchorSlug, corridorSlug] = splitMappingKey(key);
      await transaction.anchorCorridor.upsert({
        where: { anchorId_corridorId: { anchorId: anchorIds.get(anchorSlug)!, corridorId: corridorIds.get(corridorSlug)! } },
        create: {
          anchorId: anchorIds.get(anchorSlug)!,
          corridorId: corridorIds.get(corridorSlug)!,
          registryActive: true,
          registryActivatedAt: now,
        },
        update: {
          registryActive: true,
          registryActivatedAt: changes.associations.reactivated.includes(key) ? now : undefined,
          registryRetiredAt: null,
          registryRetirementReason: null,
        },
      });
    }
    for (const key of changes.associations.retired) {
      const [anchorSlug, corridorSlug] = splitMappingKey(key);
      await transaction.anchorCorridor.updateMany({
        where: {
          anchorId: anchorIds.get(anchorSlug) ?? storedAssociations.find((a) => a.anchor.slug === anchorSlug)?.anchor.id,
          corridorId: corridorIds.get(corridorSlug) ?? storedAssociations.find((a) => a.corridor.slug === corridorSlug)?.corridor.id,
        },
        data: {
          registryActive: false,
          registryRetiredAt: now,
          registryRetirementReason: REGISTRY_RETIREMENT_REASON,
        },
      });
    }

    return freezeSummary("APPLIED", changes);
  });
}

function planEntities(existing: readonly ExistingEntity[], desiredEntries: readonly Readonly<{ slug: string; signature?: string }>[]): LifecycleChanges {
  const current = new Map(existing.map((entity) => [entity.slug, entity.registryActive]));
  const signatures = new Map(existing.map((entity) => [entity.slug, entity.signature]));
  const desired = new Set(desiredEntries.map(({ slug }) => slug));
  return freezeChanges({
    activated: desiredEntries.filter(({ slug }) => !current.has(slug)).map(({ slug }) => slug),
    updated: desiredEntries.filter(({ slug, signature }) => current.get(slug) === true && signature !== undefined && signatures.get(slug) !== signature).map(({ slug }) => slug),
    retired: existing.filter(({ slug, registryActive }) => registryActive && !desired.has(slug)).map(({ slug }) => slug),
    reactivated: desiredEntries.filter(({ slug }) => current.get(slug) === false).map(({ slug }) => slug),
    unchanged: desiredEntries.filter(({ slug, signature }) => current.get(slug) === true && (signature === undefined || signatures.get(slug) === signature)).map(({ slug }) => slug),
  });
}

function anchorSignature(anchor: Pick<AnchorRegistryEntry, "name" | "homeDomain">): string {
  return `${anchor.name}\u0000${anchor.homeDomain}`;
}

function corridorSignature(corridor: Omit<CorridorRegistryEntry, "slug">): string {
  return [corridor.assetCodeFrom, corridor.countryFrom, corridor.assetCodeTo, corridor.countryTo].join("\u0000");
}

function mappingKey(anchorSlug: string, corridorSlug: string): string {
  return `${anchorSlug}/${corridorSlug}`;
}

function splitMappingKey(key: string): readonly [string, string] {
  const separator = key.indexOf("/");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function freezeChanges(changes: Record<keyof LifecycleChanges, string[]>): LifecycleChanges {
  return Object.freeze(Object.fromEntries(Object.entries(changes).map(([key, values]) =>
    [key, Object.freeze([...values].sort())])) as LifecycleChanges);
}

function freezeSummary(
  mode: RegistryReconciliationSummary["mode"],
  changes: Omit<RegistryReconciliationSummary, "mode">,
): RegistryReconciliationSummary {
  return Object.freeze({ mode, ...changes });
}
