import assert from "node:assert/strict";
import test from "node:test";

import {
  checkMaintenanceMode,
  activateMaintenanceMode,
  deactivateMaintenanceMode,
  getMaintenanceModeStatus,
  requireProductionEnvironment,
  IS_PRODUCTION_ENVIRONMENT,
} from "@/lib/maintenance";
import type {
  MaintenanceStateRecord,
  MaintenanceRepository,
  IsProductionEnvironment,
} from "@/lib/maintenance/types";

const MOCK_STATE_INACTIVE: MaintenanceStateRecord = Object.freeze({
  id: "test-id",
  active: false,
  reason: null,
  activatedAt: null,
  activatedBy: null,
  deactivatedAt: null,
  deactivatedBy: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const MOCK_STATE_ACTIVE: MaintenanceStateRecord = Object.freeze({
  id: "test-id",
  active: true,
  reason: "Scheduled maintenance",
  activatedAt: new Date("2026-09-30T10:00:00.000Z"),
  activatedBy: "operator@example.com",
  deactivatedAt: null,
  deactivatedBy: null,
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  updatedAt: new Date("2026-09-30T10:00:00.000Z"),
});

function createMockRepository(
  getStateResult: MaintenanceStateRecord | null = MOCK_STATE_INACTIVE,
): MaintenanceRepository {
  let currentState = getStateResult;
  return Object.freeze({
    getState: async () => currentState,
    activate: async (reason: string, activatedBy: string) => {
      currentState = Object.freeze({
        id: "new-id",
        active: true,
        reason,
        activatedAt: new Date(),
        activatedBy,
        deactivatedAt: null,
        deactivatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return currentState;
    },
    deactivate: async (deactivatedBy: string) => {
      if (!currentState || !currentState.active) {
        throw new Error("No active maintenance state to deactivate");
      }
      currentState = Object.freeze({
        ...currentState,
        active: false,
        deactivatedAt: new Date(),
        deactivatedBy,
        updatedAt: new Date(),
      });
      return currentState;
    },
    ensureInitialized: async () => {},
  });
}

test("checkMaintenanceMode returns ok when maintenance is inactive", async () => {
  const repository = createMockRepository(MOCK_STATE_INACTIVE);
  const result = await checkMaintenanceMode(repository);
  assert.equal(result.ok, true);
});

test("checkMaintenanceMode returns error when maintenance is active", async () => {
  const repository = createMockRepository(MOCK_STATE_ACTIVE);
  const result = await checkMaintenanceMode(repository);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MAINTENANCE_MODE_ACTIVE");
  assert.equal(
    result.error?.message,
    "Maintenance mode is active; evidence mutations are blocked.",
  );
});

test("checkMaintenanceMode fails safe when repository throws", async () => {
  const repository: MaintenanceRepository = Object.freeze({
    getState: async () => { throw new Error("DB connection failed"); },
    activate: async () => { throw new Error("unreachable"); },
    deactivate: async () => { throw new Error("unreachable"); },
    ensureInitialized: async () => {},
  });
  const result = await checkMaintenanceMode(repository);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MAINTENANCE_STATE_UNAVAILABLE");
  assert.equal(
    result.error?.message,
    "Unable to read maintenance state; failing safe.",
  );
});

test("getMaintenanceModeStatus returns inactive status when no active state", async () => {
  const repository = createMockRepository(MOCK_STATE_INACTIVE);
  const status = await getMaintenanceModeStatus(repository);
  assert.deepEqual(status, {
    active: false,
    reason: null,
    activatedAt: null,
    activatedBy: null,
  });
});

test("getMaintenanceModeStatus returns active status with details", async () => {
  const repository = createMockRepository(MOCK_STATE_ACTIVE);
  const status = await getMaintenanceModeStatus(repository);
  assert.equal(status.active, true);
  assert.equal(status.reason, "Scheduled maintenance");
  assert.equal(status.activatedAt, "2026-09-30T10:00:00.000Z");
  assert.equal(status.activatedBy, "operator@example.com");
});

test("requireProductionEnvironment fails in non-production", async () => {
  const isProduction: IsProductionEnvironment = () => false;
  const result = await requireProductionEnvironment(isProduction);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "NOT_PRODUCTION_ENVIRONMENT");
});

test("requireProductionEnvironment succeeds in production", async () => {
  const isProduction: IsProductionEnvironment = () => true;
  const result = await requireProductionEnvironment(isProduction);
  assert.equal(result.ok, true);
});

test("activateMaintenanceMode fails in non-production", async () => {
  const repository = createMockRepository();
  const isProduction: IsProductionEnvironment = () => false;
  const result = await activateMaintenanceMode(
    "test reason",
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "NOT_PRODUCTION_ENVIRONMENT");
});

test("activateMaintenanceMode succeeds in production and returns status", async () => {
  const repository = createMockRepository();
  const isProduction: IsProductionEnvironment = () => true;
  const result = await activateMaintenanceMode(
    "Emergency maintenance",
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value?.active, true);
  assert.equal(result.value?.reason, "Emergency maintenance");
  assert.equal(result.value?.activatedBy, "operator@example.com");
  assert.ok(result.value?.activatedAt);
});

test("activateMaintenanceMode fails safe on persistence error", async () => {
  const repository: MaintenanceRepository = Object.freeze({
    getState: async () => MOCK_STATE_INACTIVE,
    activate: async () => { throw new Error("DB error"); },
    deactivate: async () => { throw new Error("unreachable"); },
    ensureInitialized: async () => {},
  });
  const isProduction: IsProductionEnvironment = () => true;
  const result = await activateMaintenanceMode(
    "test",
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PERSISTENCE_FAILURE");
});

test("deactivateMaintenanceMode fails in non-production", async () => {
  const repository = createMockRepository(MOCK_STATE_ACTIVE);
  const isProduction: IsProductionEnvironment = () => false;
  const result = await deactivateMaintenanceMode(
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "NOT_PRODUCTION_ENVIRONMENT");
});

test("deactivateMaintenanceMode succeeds in production", async () => {
  const repository = createMockRepository(MOCK_STATE_ACTIVE);
  const isProduction: IsProductionEnvironment = () => true;
  const result = await deactivateMaintenanceMode(
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value?.active, false);
  assert.equal(result.value?.reason, null);
  assert.equal(result.value?.activatedAt, null);
  assert.equal(result.value?.activatedBy, null);
});

test("deactivateMaintenanceMode fails safe on persistence error", async () => {
  const repository: MaintenanceRepository = Object.freeze({
    getState: async () => MOCK_STATE_ACTIVE,
    activate: async () => { throw new Error("unreachable"); },
    deactivate: async () => { throw new Error("DB error"); },
    ensureInitialized: async () => {},
  });
  const isProduction: IsProductionEnvironment = () => true;
  const result = await deactivateMaintenanceMode(
    "operator@example.com",
    { repository, isProduction },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PERSISTENCE_FAILURE");
});

test("IS_PRODUCTION_ENVIRONMENT checks NODE_ENV and VERCEL_ENV", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercelEnv = process.env.VERCEL_ENV;

  try {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = undefined;
    assert.equal(IS_PRODUCTION_ENVIRONMENT(), true);

    process.env.NODE_ENV = "development";
    process.env.VERCEL_ENV = "production";
    assert.equal(IS_PRODUCTION_ENVIRONMENT(), true);

    process.env.NODE_ENV = "development";
    process.env.VERCEL_ENV = "preview";
    assert.equal(IS_PRODUCTION_ENVIRONMENT(), false);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.VERCEL_ENV = originalVercelEnv;
  }
});