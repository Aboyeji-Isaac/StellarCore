import type { Lockfile } from "../../../scripts/security/advisory-policy";

/** Synthetic advisory identities; they match the GHSA format but are not real advisories. */
export const ADV_A = "GHSA-2222-3333-4444";
export const ADV_B = "GHSA-5555-6666-7777";

/** Fixed clock: exceptions expiring on this UTC date are still valid. */
export const NOW = new Date("2026-09-29T12:00:00.000Z");

export const LOCKFILE: Lockfile = {
  packages: {
    "node_modules/js-yaml": { version: "4.1.0", dev: true },
    "node_modules/sharp": { version: "0.34.4" },
    "node_modules/next/node_modules/sharp": { version: "0.33.0" },
  },
};

export function advisory(name: string, id: string, severity = "high") {
  return {
    source: 1000001,
    name,
    dependency: name,
    title: `Synthetic advisory for ${name}`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "*",
  };
}

export function entry(name: string, nodes: string[], via: unknown[], severity = "high") {
  return { name, severity, isDirect: false, via, effects: [], range: "*", nodes, fixAvailable: false };
}

export function report(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

export function exception(overrides: Record<string, unknown> = {}) {
  return {
    advisoryId: ADV_A,
    package: "js-yaml",
    versionRange: ">=4.0.0 <4.2.0",
    scope: "development",
    rationale: "Dev-only YAML parsing in tooling; not bundled into the production build.",
    owner: "security-maintainers",
    expires: "2026-12-31",
    ...overrides,
  };
}

export function exceptionsFile(...exceptions: unknown[]) {
  return { version: 1, exceptions };
}
