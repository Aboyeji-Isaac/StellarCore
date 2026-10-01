import assert from "node:assert/strict";
import test from "node:test";

import {
  activateMaintenanceMode,
  checkMaintenanceMode,
  deactivateMaintenanceMode,
  getMaintenanceStatus,
} from "@/lib/maintenance";
import type {
  MaintenanceRecord,
  MaintenanceRepository,
} from "@/lib/maintenance/types";

const ACTIVE: MaintenanceRecord = Object.freeze({
  id: "maintenance-1",
  active: true,
  reason: "Reviewed database maintenance",
  activatedAt: new Date("2026-10-01T12:00:00.000Z"),
  activatedBy: "operator@example.com",
  deactivatedAt: null,
  deactivatedBy: null,
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
});

function repository(initial: MaintenanceRecord | null): MaintenanceRepository {
  let active = initial;
  return Object.freeze({
    getActive: async () => active,
    activate: async ({ reason, operator, at }) => {
      if (active) throw new Error("ACTIVE_EXISTS");
      active = Object.freeze({
        id: "maintenance-new",
        active: true,
        reason,
        activatedAt: at,
        activatedBy: operator,
        deactivatedAt: null,
        deactivatedBy: null,
        createdAt: at,
        updatedAt: at,
      });
      return active;
    },
    deactivate: async ({ operator, at }) => {
      if (!active) return null;
      active = Object.freeze({
        ...active,
        active: false,
        deactivatedAt: at,
        deactivatedBy: operator,
        updatedAt: at,
      });
      return active;
    },
  });
}

test("inactive state allows mutations", async () => {
  const result = await checkMaintenanceMode(repository(null));
  assert.deepEqual(result, { ok: true, value: undefined });
});

test("active state blocks mutations", async () => {
  const result = await checkMaintenanceMode(repository(ACTIVE));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "MAINTENANCE_MODE_ACTIVE");
});

test("unreadable state fails safe", async () => {
  const broken: MaintenanceRepository = Object.freeze({
    getActive: async () => { throw new Error("offline"); },
    activate: async () => { throw new Error("offline"); },
    deactivate: async () => { throw new Error("offline"); },
  });
  const result = await checkMaintenanceMode(broken);
  assert.equal(result.ok, false);
  assert.equal(
    !result.ok && result.error.code,
    "MAINTENANCE_STATE_UNAVAILABLE",
  );
});

test("status exposes bounded operator-visible reason and activation time", async () => {
  const result = await getMaintenanceStatus(repository(ACTIVE));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    active: true,
    reason: "Reviewed database maintenance",
    activatedAt: "2026-10-01T12:00:00.000Z",
    activatedBy: "operator@example.com",
  });
});

test("toggles are production scoped", async () => {
  const repo = repository(null);
  const activate = await activateMaintenanceMode(
    "Reviewed database maintenance",
    "operator@example.com",
    { repository: repo, environment: "preview" },
  );
  assert.equal(activate.ok, false);
  assert.equal(
    !activate.ok && activate.error.code,
    "NOT_PRODUCTION_ENVIRONMENT",
  );

  const deactivate = await deactivateMaintenanceMode(
    "operator@example.com",
    { repository: repository(ACTIVE), environment: "development" },
  );
  assert.equal(deactivate.ok, false);
});

test("activation and deactivation preserve explicit audit metadata", async () => {
  const repo = repository(null);
  const now = () => new Date("2026-10-01T13:00:00.000Z");
  const activated = await activateMaintenanceMode(
    "Reviewed database maintenance",
    "operator@example.com",
    { repository: repo, environment: "production", now },
  );
  assert.equal(activated.ok, true);

  const status = await getMaintenanceStatus(repo);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.value.activatedBy, "operator@example.com");
    assert.equal(status.value.activatedAt, "2026-10-01T13:00:00.000Z");
  }

  const deactivated = await deactivateMaintenanceMode(
    "second-operator@example.com",
    { repository: repo, environment: "production", now },
  );
  assert.equal(deactivated.ok, true);
});

test("invalid reason/operator input fails closed", async () => {
  const repo = repository(null);
  const result = await activateMaintenanceMode(
    "short",
    "x",
    { repository: repo, environment: "production" },
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "INVALID_INPUT");
});
