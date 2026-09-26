import type {
  AlertDeliveryMethodType,
  RateAlertSubscriptionRecord,
} from "@/types/alerts";

export type AlertSubscriptionRepository = Readonly<{
  findCorridorBySlug: (slug: string) => Promise<Readonly<{
    id: string;
    slug: string;
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
  }> | null>;

  createSubscription: (input: Readonly<{
    corridorId: string;
    deliveryMethod: AlertDeliveryMethodType;
    destination: string;
    secret: string;
    thresholdPercent: number;
  }>) => Promise<RateAlertSubscriptionRecord>;

  findSubscriptionById: (
    id: string,
  ) => Promise<RateAlertSubscriptionRecord | null>;

  findSubscriptionsByCorridor: (
    corridorId: string,
    activeOnly?: boolean,
  ) => Promise<readonly RateAlertSubscriptionRecord[]>;

  deactivateSubscription: (id: string) => Promise<boolean>;

  updateLastNotified: (id: string, notifiedAt: Date) => Promise<void>;
}>;

export const PRISMA_ALERT_SUBSCRIPTION_REPOSITORY: AlertSubscriptionRepository =
  Object.freeze({
    async findCorridorBySlug(slug) {
      const { db } = await import("@/lib/dbClient");
      return db.corridor.findUnique({
        where: { slug },
        select: {
          id: true,
          slug: true,
          assetCodeFrom: true,
          countryFrom: true,
          assetCodeTo: true,
          countryTo: true,
        },
      });
    },

    async createSubscription(input) {
      const { db } = await import("@/lib/dbClient");
      const created = await db.rateAlertSubscription.create({
        data: {
          corridorId: input.corridorId,
          deliveryMethod: input.deliveryMethod,
          destination: input.destination,
          secret: input.secret,
          thresholdPercent: input.thresholdPercent,
          isActive: true,
        },
        include: {
          corridor: {
            select: { slug: true },
          },
        },
      });

      return toSubscriptionRecord(created, created.corridor.slug);
    },

    async findSubscriptionById(id) {
      const { db } = await import("@/lib/dbClient");
      const row = await db.rateAlertSubscription.findUnique({
        where: { id },
        include: {
          corridor: {
            select: { slug: true },
          },
        },
      });
      if (!row) return null;
      return toSubscriptionRecord(row, row.corridor.slug);
    },

    async findSubscriptionsByCorridor(corridorId, activeOnly = true) {
      const { db } = await import("@/lib/dbClient");
      const rows = await db.rateAlertSubscription.findMany({
        where: {
          corridorId,
          ...(activeOnly ? { isActive: true } : {}),
        },
        include: {
          corridor: {
            select: { slug: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return Object.freeze(
        rows.map((row) => toSubscriptionRecord(row, row.corridor.slug)),
      );
    },

    async deactivateSubscription(id) {
      const { db } = await import("@/lib/dbClient");
      try {
        await db.rateAlertSubscription.update({
          where: { id },
          data: { isActive: false },
        });
        return true;
      } catch {
        return false;
      }
    },

    async updateLastNotified(id, notifiedAt) {
      const { db } = await import("@/lib/dbClient");
      try {
        await db.rateAlertSubscription.update({
          where: { id },
          data: { lastNotifiedAt: notifiedAt },
        });
      } catch {
        // Safe silence
      }
    },
  });

function toSubscriptionRecord(
  row: {
    id: string;
    corridorId: string;
    deliveryMethod: string;
    destination: string;
    secret: string;
    thresholdPercent: number;
    isActive: boolean;
    lastNotifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  corridorSlug: string,
): RateAlertSubscriptionRecord {
  return Object.freeze({
    id: row.id,
    corridorId: row.corridorId,
    corridorSlug,
    deliveryMethod: row.deliveryMethod as AlertDeliveryMethodType,
    destination: row.destination,
    secret: row.secret,
    thresholdPercent: row.thresholdPercent,
    isActive: row.isActive,
    lastNotifiedAt: row.lastNotifiedAt ? new Date(row.lastNotifiedAt.getTime()) : null,
    createdAt: new Date(row.createdAt.getTime()),
    updatedAt: new Date(row.updatedAt.getTime()),
  });
}
