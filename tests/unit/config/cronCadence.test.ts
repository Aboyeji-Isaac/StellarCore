import assert from "node:assert/strict";
import test from "node:test";

import {
  auditCronCadenceConfiguration,
  EXPECTED_CRON_PATH,
  EXPECTED_CRON_SCHEDULE,
} from "@/lib/config/cronCadence";

const expected = Object.freeze({
  crons: Object.freeze([Object.freeze({
    path: EXPECTED_CRON_PATH,
    schedule: EXPECTED_CRON_SCHEDULE,
  })]),
});

test("expected daily UTC cadence passes", () => {
  assert.deepEqual(auditCronCadenceConfiguration(expected), { ok: true, issues: [] });
});

test("missing cron configuration fails clearly", () => {
  assert.deepEqual(auditCronCadenceConfiguration({}), {
    ok: false,
    issues: [{ code: "CRON_CONFIGURATION_MISSING", field: "crons" }],
  });
  assert.deepEqual(auditCronCadenceConfiguration({ crons: [] }).issues, [
    { code: "CRON_CONFIGURATION_MISSING", field: "crons" },
  ]);
});

test("malformed cron shape and expression fail clearly", () => {
  assert.equal(auditCronCadenceConfiguration({ crons: null }).issues[0]?.code, "CRON_CONFIGURATION_MALFORMED");
  assert.deepEqual(auditCronCadenceConfiguration({ crons: [{ path: EXPECTED_CRON_PATH }] }).issues, [
    { code: "CRON_CONFIGURATION_MALFORMED", field: "schedule" },
  ]);
  assert.deepEqual(auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: "60 0 * * *" }],
  }).issues, [{ code: "CRON_CONFIGURATION_MALFORMED", field: "schedule" }]);
  assert.deepEqual(auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: "0 0 * *" }],
  }).issues, [{ code: "CRON_CONFIGURATION_MALFORMED", field: "schedule" }]);
});

test("valid but more frequent cron expressions fail cadence verification", () => {
  const result = auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: "0 */6 * * *" }],
  });
  assert.deepEqual(result.issues, [{ code: "CRON_CADENCE_DRIFT", field: "schedule" }]);
});

test("valid cron field boundaries are parsed and reported as drift when not expected", () => {
  const result = auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: "59 23 31 12 6" }],
  });
  assert.deepEqual(result.issues, [{ code: "CRON_CADENCE_DRIFT", field: "schedule" }]);
});

test("timezone overrides and timezone-prefixed expressions fail verification", () => {
  const override = auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: EXPECTED_CRON_SCHEDULE, timezone: "America/Los_Angeles" }],
  });
  const prefixed = auditCronCadenceConfiguration({
    crons: [{ path: EXPECTED_CRON_PATH, schedule: `TZ=America/Los_Angeles ${EXPECTED_CRON_SCHEDULE}` }],
  });
  assert.deepEqual(override.issues, [{ code: "CRON_TIMEZONE_DRIFT", field: "timezone" }]);
  assert.deepEqual(prefixed.issues, [{ code: "CRON_TIMEZONE_DRIFT", field: "schedule" }]);
});

test("wrong route and multiple jobs fail verification", () => {
  assert.equal(auditCronCadenceConfiguration({
    crons: [{ path: "/api/other", schedule: EXPECTED_CRON_SCHEDULE }],
  }).issues[0]?.code, "CRON_PATH_DRIFT");
  assert.equal(auditCronCadenceConfiguration({ crons: [expected.crons[0], expected.crons[0]] }).issues[0]?.code, "CRON_JOB_COUNT_DRIFT");
});

test("audit output is deterministic and immutable", () => {
  const drift = { crons: [{ path: "/api/other", schedule: "0 */6 * * *", timezone: "Europe/London" }] };
  const first = auditCronCadenceConfiguration(drift);
  const second = auditCronCadenceConfiguration(drift);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.issues), true);
  assert.equal(Object.isFrozen(first.issues[0]), true);
});
