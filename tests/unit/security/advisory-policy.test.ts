import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateAdvisoryPolicy,
  exitCodeFor,
  renderSummary,
  versionInRange,
  type PolicyOptions,
} from "../../../scripts/security/advisory-policy";
import {
  ADV_A,
  ADV_B,
  LOCKFILE,
  NOW,
  advisory,
  entry,
  exception,
  exceptionsFile,
  report,
} from "./advisory-fixtures";

const run = (rep: unknown, exc: unknown = exceptionsFile(), options?: PolicyOptions) =>
  evaluateAdvisoryPolicy({ report: rep, lockfile: LOCKFILE, exceptions: exc, now: NOW, options });

const jsYaml = () =>
  report({ "js-yaml": entry("js-yaml", ["node_modules/js-yaml"], [advisory("js-yaml", ADV_A)]) });

test("clean report passes with exit code 0", () => {
  const r = run(report({}));
  assert.equal(r.status, "pass");
  assert.equal(exitCodeFor(r.status), 0);
});

test("patched top-level with a vulnerable nested copy still fails, naming the nested path", () => {
  const rep = report({
    sharp: entry("sharp", ["node_modules/next/node_modules/sharp"], [advisory("sharp", ADV_B)]),
  });
  const r = run(rep);
  assert.equal(r.status, "policy-violation");
  assert.equal(r.findings[0].nodePath, "node_modules/next/node_modules/sharp");
  assert.equal(r.findings[0].version, "0.33.0");
  assert.equal(r.findings[0].scope, "production");
});

test("every installed copy is evaluated, not just the first", () => {
  const rep = report({
    sharp: entry(
      "sharp",
      ["node_modules/sharp", "node_modules/next/node_modules/sharp"],
      [advisory("sharp", ADV_B)],
    ),
  });
  const exc = exceptionsFile(
    exception({ advisoryId: ADV_B, package: "sharp", versionRange: ">=0.34.0 <0.35.0", scope: "production" }),
  );
  const r = run(rep, exc);
  assert.equal(r.status, "policy-violation");
  const byPath = Object.fromEntries(r.findings.map((f) => [f.nodePath, f.disposition]));
  assert.equal(byPath["node_modules/sharp"], "excepted");
  assert.equal(byPath["node_modules/next/node_modules/sharp"], "blocking");
});

test("a newly disclosed advisory fails without any lockfile change", () => {
  const rep = report({
    "js-yaml": entry("js-yaml", ["node_modules/js-yaml"], [advisory("js-yaml", ADV_A), advisory("js-yaml", ADV_B)]),
  });
  const r = run(rep, exceptionsFile(exception()));
  assert.equal(r.status, "policy-violation");
  assert.deepEqual(
    r.findings.map((f) => [f.advisoryId, f.disposition]).sort(),
    [[ADV_A, "excepted"], [ADV_B, "blocking"]],
  );
});

test("valid exception passes and dev scope is derived from the lockfile", () => {
  const r = run(jsYaml(), exceptionsFile(exception()));
  assert.equal(r.status, "pass");
  assert.equal(r.findings[0].scope, "development");
  assert.equal(r.findings[0].disposition, "excepted");
});

test("exception is not a bypass: wrong scope, package or version range do not match", () => {
  for (const over of [{ scope: "production" }, { versionRange: ">=3.0.0 <4.0.0" }, { advisoryId: ADV_B }]) {
    assert.equal(run(jsYaml(), exceptionsFile(exception(over))).status, "policy-violation", JSON.stringify(over));
  }
});

test("expired exception fails with its own status, including on its last day boundary", () => {
  const expired = run(jsYaml(), exceptionsFile(exception({ expires: "2026-09-28" })));
  assert.equal(expired.status, "expired-exception");
  assert.equal(expired.findings[0].disposition, "expired-exception");
  const lastDay = run(jsYaml(), exceptionsFile(exception({ expires: "2026-09-29" })));
  assert.equal(lastDay.status, "pass");
});

test("findings below the configured threshold do not block", () => {
  const rep = report({
    "js-yaml": entry("js-yaml", ["node_modules/js-yaml"], [advisory("js-yaml", ADV_A, "low")], "low"),
  });
  assert.equal(run(rep, exceptionsFile(), { minBlockingSeverity: "high" }).status, "pass");
  assert.equal(run(rep).status, "policy-violation");
});

test("malformed scanner output is never a pass", () => {
  const cases: unknown[] = [
    null,
    "not json",
    [],
    {},
    { auditReportVersion: 1, vulnerabilities: {} },
    { auditReportVersion: 2, vulnerabilities: [] },
    report({ x: "nope" }),
    report({ "js-yaml": entry("js-yaml", ["node_modules/js-yaml"], [{ name: "js-yaml", severity: "bogus" }]) }),
    report({ "js-yaml": entry("js-yaml", ["node_modules/js-yaml"], [{ ...advisory("js-yaml", ADV_A), url: "", source: undefined }]) }),
    report({ "js-yaml": entry("js-yaml", ["node_modules/missing/js-yaml"], [advisory("js-yaml", ADV_A)]) }),
  ];
  for (const c of cases) {
    const r = run(c);
    assert.equal(r.status, "malformed-output", JSON.stringify(c));
    assert.equal(exitCodeFor(r.status), 2);
  }
});

test("scanner error payload is a scanner failure, distinct from violation, with no raw text echoed", () => {
  const r = run({ error: { code: "ENOAUDIT", summary: "https://user:hunter2@registry.example/x failed" } });
  assert.equal(r.status, "scanner-failure");
  assert.equal(exitCodeFor(r.status), 3);
  assert.ok(!JSON.stringify(r).includes("hunter2"));
});

test("invalid exceptions fail closed: wildcards, unbounded ranges, unknown fields, far expiry, bad dates", () => {
  const bad = [
    exception({ package: "*" }),
    exception({ package: "@scope/*" }),
    exception({ versionRange: ">=1.0.0" }),
    exception({ versionRange: "*" }),
    exception({ scope: "all" }),
    exception({ rationale: "short" }),
    exception({ owner: "" }),
    exception({ expires: "2030-01-01" }),
    exception({ expires: "2026-02-31" }),
    exception({ advisoryId: "GHSA-*" }),
    { ...exception(), allDevDependencies: true },
  ];
  for (const b of bad) {
    const r = run(jsYaml(), exceptionsFile(b));
    assert.equal(r.status, "invalid-exceptions", JSON.stringify(b));
  }
  assert.equal(run(jsYaml(), { version: 2, exceptions: [] }).status, "invalid-exceptions");
  assert.equal(run(jsYaml(), exceptionsFile(exception(), exception())).status, "invalid-exceptions");
});

test("unused exceptions are reported but do not fail", () => {
  const r = run(report({}), exceptionsFile(exception()));
  assert.equal(r.status, "pass");
  assert.equal(r.unusedExceptions.length, 1);
});

test("only pass maps to exit code 0", () => {
  const codes = (["policy-violation", "expired-exception", "malformed-output", "invalid-exceptions", "scanner-failure"] as const).map(exitCodeFor);
  assert.ok(codes.every((c) => c !== 0));
});

test("versionInRange handles bounds and refuses prereleases", () => {
  assert.ok(versionInRange("4.3.1", ">=4.0.0 <4.4.0"));
  assert.ok(!versionInRange("4.4.0", ">=4.0.0 <4.4.0"));
  assert.ok(versionInRange("1.2.3", "=1.2.3"));
  assert.ok(!versionInRange("1.2.3-beta.1", "<2.0.0"));
});

test("summary is redacted and carries the scope disclaimer", () => {
  const s = renderSummary(run(jsYaml()));
  assert.match(s, /policy-violation/);
  assert.match(s, /not proof/);
  assert.match(s, new RegExp(ADV_A));
});
