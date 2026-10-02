import { appendOperatorAction } from "@/lib/audit/recordOperatorAction";
import type { RegistryLifecycleRepository } from "@/lib/administration/registryLifecycle";

/**
 * Prisma implementation. Retirement and reactivation update only the reviewed
 * lifecycle state of a persisted anchor and append the ledger row in the same
 * transaction. They never rewrite evidence rows or claim external anchor health.
 */
export const PRISMA_REGISTRY_LIFECYCLE_REPOSITORY: RegistryLifecycleRepository = Object.freeze({
  async findAnchor(slug) {
    const { db } = await import("@/lib/dbClient");
    const row = await db.anchor.findUnique({
      where: { slug },
      select: { id: true, slug: true, lifecycleState: true },
    });
    if (!row) return null;

    return Object.freeze({
      anchorId: row.id,
      slug: row.slug,
      lifecycleState: row.lifecycleState,
    });
  },

  async applyLifecycleChange(input) {
    const { db } = await import("@/lib/dbClient");
    return db.$transaction(async (transaction) => {
      const current = await transaction.anchor.findUnique({
        where: { slug: input.anchor.slug },
        select: { id: true, lifecycleState: true },
      });
      if (!current) return { ok: false as const, code: "TARGET_NOT_FOUND" as const };
      if (current.lifecycleState === input.nextState) {
        return { ok: false as const, code: "STATE_CONFLICT" as const };
      }

      const action = await appendOperatorAction(transaction, input.action);

      const updated = await transaction.anchor.update({
        where: { slug: input.anchor.slug },
        data: {
          lifecycleState: input.nextState,
          retiredAt: input.nextState === "RETIRED" ? new Date() : null,
        },
        select: { id: true, slug: true, lifecycleState: true },
      });

      return {
        ok: true as const,
        anchor: Object.freeze({
          anchorId: updated.id,
          slug: updated.slug,
          lifecycleState: updated.lifecycleState,
        }),
        action,
      };
    });
  },
});
