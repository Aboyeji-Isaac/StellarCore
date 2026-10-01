import { getRuntimeConfig } from "@/lib/config/runtimeConfig";
import type {
  MaintenanceRecord,
  MaintenanceRepository,
  MaintenanceResult,
  MaintenanceStatus,
} from "@/lib/maintenance/types";

function toRecord(row: {
  id: string;
  active: boolean;
  reason: string;
  activatedAt: Date;
  activatedBy: string;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MaintenanceRecord {
  return Object.freeze({ ...row });
}

export const PRISMA_MAINTENANCE_REPOSITORY: MaintenanceRepository =
  Object.freeze({
    async getActive() {
      const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
      await ensureDatabaseEnvironment();
      const row = await db.maintenanceState.findFirst({
        where: { active: true },
        orderBy: { activatedAt: "desc" },
      });
      return row ? toRecord(row) : null;
    },

    async activate({ reason, operator, at }) {
      const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
      await ensureDatabaseEnvironment();
      return db.$transaction(async (tx) => {
        const existing = await tx.maintenanceState.findFirst({
          where: { active: true },
          select: { id: true },
        });
        if (existing) throw new Error("ACTIVE_EXISTS");
        return toRecord(
          await tx.maintenanceState.create({
            data: {
              active: true,
              reason,
              activatedAt: at,
              activatedBy: operator,
            },
          }),
        );
      });
    },

    async deactivate({ operator, at }) {
      const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
      await ensureDatabaseEnvironment();
      return db.$transaction(async (tx) => {
        const active = await tx.maintenanceState.findFirst({
          where: { active: true },
          orderBy: { activatedAt: "desc" },
        });
        if (!active) return null;
        return toRecord(
          await tx.maintenanceState.update({
            where: { id: active.id },
            data: {
              active: false,
              deactivatedAt: at,
              deactivatedBy: operator,
            },
          }),
        );
      });
    },
  });

export async function checkMaintenanceMode(
  repository: MaintenanceRepository = PRISMA_MAINTENANCE_REPOSITORY,
): Promise<MaintenanceResult<void>> {
  try {
    const active = await repository.getActive();
    if (active) {
      return failure(
        "MAINTENANCE_MODE_ACTIVE",
        "Maintenance mode is active; evidence mutations are blocked.",
      );
    }
    return Object.freeze({ ok: true, value: undefined });
  } catch {
    return failure(
      "MAINTENANCE_STATE_UNAVAILABLE",
      "Maintenance state is unavailable; evidence mutations are blocked.",
    );
  }
}

export async function getMaintenanceStatus(
  repository: MaintenanceRepository = PRISMA_MAINTENANCE_REPOSITORY,
): Promise<MaintenanceResult<MaintenanceStatus>> {
  try {
    const active = await repository.getActive();
    return Object.freeze({
      ok: true,
      value: active
        ? Object.freeze({
            active: true,
            reason: active.reason,
            activatedAt: active.activatedAt.toISOString(),
            activatedBy: active.activatedBy,
          })
        : Object.freeze({
            active: false,
            reason: null,
            activatedAt: null,
            activatedBy: null,
          }),
    });
  } catch {
    return failure(
      "MAINTENANCE_STATE_UNAVAILABLE",
      "Maintenance state is unavailable.",
    );
  }
}

export async function activateMaintenanceMode(
  reason: string,
  operator: string,
  options: Readonly<{
    repository?: MaintenanceRepository;
    environment?: string;
    now?: () => Date;
  }> = {},
): Promise<MaintenanceResult<MaintenanceStatus>> {
  const environment = options.environment ?? getRuntimeConfig().environment;
  if (environment !== "production") {
    return failure(
      "NOT_PRODUCTION_ENVIRONMENT",
      "Maintenance mode can only be toggled in production.",
    );
  }
  const normalizedReason = normalizeReason(reason);
  const normalizedOperator = normalizeOperator(operator);
  if (!normalizedReason || !normalizedOperator) {
    return failure(
      "INVALID_INPUT",
      "Maintenance reason/operator input is invalid.",
    );
  }

  try {
    const row = await (
      options.repository ?? PRISMA_MAINTENANCE_REPOSITORY
    ).activate({
      reason: normalizedReason,
      operator: normalizedOperator,
      at: (options.now ?? (() => new Date()))(),
    });
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        active: true,
        reason: row.reason,
        activatedAt: row.activatedAt.toISOString(),
        activatedBy: row.activatedBy,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ACTIVE_EXISTS") {
      return failure(
        "INVALID_TRANSITION",
        "Maintenance mode is already active.",
      );
    }
    return failure(
      "PERSISTENCE_FAILURE",
      "Failed to activate maintenance mode.",
    );
  }
}

export async function deactivateMaintenanceMode(
  operator: string,
  options: Readonly<{
    repository?: MaintenanceRepository;
    environment?: string;
    now?: () => Date;
  }> = {},
): Promise<MaintenanceResult<MaintenanceStatus>> {
  const environment = options.environment ?? getRuntimeConfig().environment;
  if (environment !== "production") {
    return failure(
      "NOT_PRODUCTION_ENVIRONMENT",
      "Maintenance mode can only be toggled in production.",
    );
  }
  const normalizedOperator = normalizeOperator(operator);
  if (!normalizedOperator) {
    return failure(
      "INVALID_INPUT",
      "Maintenance operator input is invalid.",
    );
  }

  try {
    const row = await (
      options.repository ?? PRISMA_MAINTENANCE_REPOSITORY
    ).deactivate({
      operator: normalizedOperator,
      at: (options.now ?? (() => new Date()))(),
    });
    if (!row) {
      return failure(
        "INVALID_TRANSITION",
        "Maintenance mode is not active.",
      );
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        active: false,
        reason: null,
        activatedAt: null,
        activatedBy: null,
      }),
    });
  } catch {
    return failure(
      "PERSISTENCE_FAILURE",
      "Failed to deactivate maintenance mode.",
    );
  }
}

function normalizeReason(value: string): string | null {
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) return null;
  return normalized;
}

function normalizeOperator(value: string): string | null {
  const normalized = value.trim();
  if (
    normalized.length < 2 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) return null;
  return normalized;
}

function failure(
  code: Extract<MaintenanceResult<never>, { ok: false }>["error"]["code"],
  message: string,
): MaintenanceResult<never> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message }),
  });
}
