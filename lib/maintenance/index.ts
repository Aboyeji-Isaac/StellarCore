import { db } from "@/lib/dbClient";
import type {
  MaintenanceModeStatus,
  MaintenanceModeError,
  MaintenanceModeResult,
  MaintenanceStateRecord,
  MaintenanceRepository,
  IsProductionEnvironment,
} from "@/lib/maintenance/types";

const PRODUCTION_ENVIRONMENTS = new Set([
  "production",
  "prod",
]);

function isProductionEnvironment(): boolean {
  const env = process.env.NODE_ENV ?? "";
  const vercelEnv = process.env.VERCEL_ENV ?? "";
  return PRODUCTION_ENVIRONMENTS.has(env) || PRODUCTION_ENVIRONMENTS.has(vercelEnv);
}

function toMaintenanceModeStatus(record: MaintenanceStateRecord | null): MaintenanceModeStatus {
  if (!record || !record.active) {
    return Object.freeze({
      active: false,
      reason: null,
      activatedAt: null,
      activatedBy: null,
    });
  }
  return Object.freeze({
    active: true,
    reason: record.reason,
    activatedAt: record.activatedAt.toISOString(),
    activatedBy: record.activatedBy,
  });
}

async function getState(): Promise<MaintenanceStateRecord | null> {
  const state = await db.maintenanceState.findFirst({
    where: { active: true },
    orderBy: { activatedAt: "desc" },
  });
  if (!state) return null;
  return Object.freeze({
    ...state,
    activatedAt: state.activatedAt ?? null,
    deactivatedAt: state.deactivatedAt ?? null,
  });
}

async function activate(reason: string, activatedBy: string): Promise<MaintenanceStateRecord> {
  const now = new Date();
  const record = await db.maintenanceState.create({
    data: {
      active: true,
      reason,
      activatedAt: now,
      activatedBy,
    },
  });
  return Object.freeze({
    ...record,
    activatedAt: record.activatedAt ?? null,
    deactivatedAt: record.deactivatedAt ?? null,
  });
}

async function deactivate(deactivatedBy: string): Promise<MaintenanceStateRecord> {
  const now = new Date();
  const record = await db.maintenanceState.findFirst({
    where: { active: true },
    orderBy: { activatedAt: "desc" },
  });
  if (!record) {
    throw new Error("No active maintenance state to deactivate");
  }
  const updated = await db.maintenanceState.update({
    where: { id: record.id },
    data: {
      active: false,
      deactivatedAt: now,
      deactivatedBy,
    },
  });
  return Object.freeze({
    ...updated,
    activatedAt: updated.activatedAt ?? null,
    deactivatedAt: updated.deactivatedAt ?? null,
  });
}

async function ensureInitialized(): Promise<void> {
  const existing = await db.maintenanceState.findFirst();
  if (!existing) {
    await db.maintenanceState.create({
      data: {
        active: false,
        activatedAt: new Date("1970-01-01T00:00:00.000Z"),
      },
    });
  }
}

export const MAINTENANCE_REPOSITORY: MaintenanceRepository = Object.freeze({
  getState,
  activate,
  deactivate,
  ensureInitialized,
});

export const IS_PRODUCTION_ENVIRONMENT: IsProductionEnvironment = isProductionEnvironment;

export async function checkMaintenanceMode(
  repository: MaintenanceRepository = MAINTENANCE_REPOSITORY,
): Promise<MaintenanceModeResult<void>> {
  let state: MaintenanceStateRecord | null;
  try {
    state = await repository.getState();
  } catch {
    const error: MaintenanceModeError = Object.freeze({
      code: "MAINTENANCE_STATE_UNAVAILABLE",
      message: "Unable to read maintenance state; failing safe.",
    });
    return Object.freeze({ ok: false, error });
  }

  if (state?.active) {
    const error: MaintenanceModeError = Object.freeze({
      code: "MAINTENANCE_MODE_ACTIVE",
      message: "Maintenance mode is active; evidence mutations are blocked.",
    });
    return Object.freeze({ ok: false, error });
  }

  return Object.freeze({ ok: true, value: undefined });
}

export async function requireProductionEnvironment(
  isProduction: IsProductionEnvironment = IS_PRODUCTION_ENVIRONMENT,
): Promise<MaintenanceModeResult<void>> {
  if (!isProduction()) {
    const error: MaintenanceModeError = Object.freeze({
      code: "NOT_PRODUCTION_ENVIRONMENT",
      message: "Maintenance mode can only be toggled in production environments.",
    });
    return Object.freeze({ ok: false, error });
  }
  return Object.freeze({ ok: true, value: undefined });
}

export async function activateMaintenanceMode(
  reason: string,
  activatedBy: string,
  dependencies: Readonly<{
    repository: MaintenanceRepository;
    isProduction: IsProductionEnvironment;
  }> = { repository: MAINTENANCE_REPOSITORY, isProduction: IS_PRODUCTION_ENVIRONMENT },
): Promise<MaintenanceModeResult<MaintenanceModeStatus>> {
  const envCheck = await requireProductionEnvironment(dependencies.isProduction);
  if (!envCheck.ok) return envCheck;

  let record: MaintenanceStateRecord;
  try {
    await dependencies.repository.ensureInitialized();
    record = await dependencies.repository.activate(reason, activatedBy);
  } catch {
    const error: MaintenanceModeError = Object.freeze({
      code: "PERSISTENCE_FAILURE",
      message: "Failed to persist maintenance state activation.",
    });
    return Object.freeze({ ok: false, error });
  }

  return Object.freeze({ ok: true, value: toMaintenanceModeStatus(record) });
}

export async function deactivateMaintenanceMode(
  deactivatedBy: string,
  dependencies: Readonly<{
    repository: MaintenanceRepository;
    isProduction: IsProductionEnvironment;
  }> = { repository: MAINTENANCE_REPOSITORY, isProduction: IS_PRODUCTION_ENVIRONMENT },
): Promise<MaintenanceModeResult<MaintenanceModeStatus>> {
  const envCheck = await requireProductionEnvironment(dependencies.isProduction);
  if (!envCheck.ok) return envCheck;

  let record: MaintenanceStateRecord;
  try {
    record = await dependencies.repository.deactivate(deactivatedBy);
  } catch {
    const error: MaintenanceModeError = Object.freeze({
      code: "PERSISTENCE_FAILURE",
      message: "Failed to persist maintenance state deactivation.",
    });
    return Object.freeze({ ok: false, error });
  }

  return Object.freeze({ ok: true, value: toMaintenanceModeStatus(record) });
}

export async function getMaintenanceModeStatus(
  repository: MaintenanceRepository = MAINTENANCE_REPOSITORY,
): Promise<MaintenanceModeStatus> {
  const state = await repository.getState();
  return toMaintenanceModeStatus(state);
}