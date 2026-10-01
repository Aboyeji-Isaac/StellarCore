import { createHash } from "node:crypto";

/**
 * Pure logic for the dependency-install reproducibility verification
 * (`npm run verify:install-reproducibility`, issue #237). Everything in this
 * module is deterministic and free of I/O so it can be unit tested; the
 * orchestrating script owns sandboxing, installs, and report writing.
 *
 * Normalization rules (documented in docs/dependency-install-reproducibility.md):
 * R1. Package collections are compared as path-keyed maps; map ordering never
 *     affects the result.
 * R2. Only graph-relevant lockfile fields are retained (name, version,
 *     resolved, integrity, install flags, lifecycle marker, platform gates,
 *     dependency edges). Fields such as `funding` are dropped, but name,
 *     version, integrity, and edges are always retained so no package or
 *     version change can be normalized away.
 * R3. Dependency edge lists are canonicalized as sorted name-version maps.
 * R4. Absolute paths from individual sandboxes are replaced with `<sandbox>`
 *     before hashing; comparisons therefore never depend on sandbox locations.
 * R5. File mtimes, sizes, and permissions are ignored; generated artifacts are
 *     compared by content digest only.
 * R6. Raw npm install logs are attached as diagnostics but never compared
 *     byte-for-byte; only the structured install result (exit code, toolchain,
 *     lockfile mutation digest) participates in the verdict.
 */

export const DEFAULT_MAX_DIFFERENCES = 50;
export const MAX_DIFF_VALUE_LENGTH = 240;
export const ARTIFACT_HASH_ALGORITHM = "sha256" as const;
export const INSTALL_REPORT_SCHEMA_VERSION = 1 as const;

export const NORMALIZATION_RULES = [
  "R1: package collections are compared as path-keyed maps; ordering never affects results",
  "R2: only graph-relevant lockfile fields are retained; name, version, resolved, integrity, install flags, lifecycle markers, platform gates, and dependency edges are always kept so no package/version change can be hidden",
  "R3: dependency edges are canonicalized as name->version maps with sorted keys",
  "R4: absolute sandbox paths are replaced with <sandbox> before hashing",
  "R5: file mtimes, sizes, and permissions are ignored; generated artifacts compare by content digest only",
  "R6: raw npm logs are diagnostics only and are never compared byte-for-byte",
] as const;

export interface NormalizedPackageEntry {
  name?: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  hasInstallScript?: boolean;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface NormalizedDependencyGraph {
  lockfileVersion: number | string | null;
  root: NormalizedPackageEntry | null;
  packages: Record<string, NormalizedPackageEntry>;
}

export interface PlatformContext {
  os: string;
  cpu: string;
  libc?: string;
}

export type GraphDifference =
  | { kind: "lockfile-version-changed"; expected: string; actual: string }
  | { kind: "root-changed"; field: string; expected: string; actual: string }
  | { kind: "package-added"; path: string; actual: string }
  | { kind: "package-removed"; path: string; expected: string }
  | {
      kind: "package-changed";
      path: string;
      field: string;
      expected: string;
      actual: string;
    };

export interface BoundedDiff<T> {
  total: number;
  shown: T[];
  truncated: boolean;
  maxShown: number;
}

export type InstallAuditIssue =
  | { code: "unexpected-package"; path: string; actual: string }
  | { code: "missing-package"; path: string; expected: string }
  | { code: "name-mismatch"; path: string; expected: string; actual: string }
  | { code: "version-mismatch"; path: string; expected: string; actual: string }
  | {
      code: "integrity-mismatch";
      path: string;
      expected: string;
      actual: string;
    }
  | {
      code: "resolved-mismatch";
      path: string;
      expected: string;
      actual: string;
    }
  | {
      code: "install-script-drift";
      path: string;
      expected: boolean;
      actual: boolean;
    }
  | {
      code: "install-flag-mismatch";
      path: string;
      field: "peer";
      expected: boolean;
      actual: boolean;
    }
  | {
      // Scope bookkeeping (dev, devOptional, optional) differs across npm
      // minor versions without changing what npm ci resolves or installs;
      // reported, never fatal.
      code: "scope-flag-drift";
      path: string;
      field: "dev" | "devOptional" | "optional";
      expected: boolean;
      actual: boolean;
    }
  | {
      code: "dependency-edge-mismatch";
      path: string;
      field: "dependencies" | "optionalDependencies" | "peerDependencies";
      expected: string;
      actual: string;
    };

export interface InstalledPackageRecord {
  name: string;
  version: string;
  hasInstallScript: boolean;
}

export type ScanDifference =
  | { kind: "package-added"; path: string; actual: string }
  | { kind: "package-removed"; path: string; expected: string }
  | {
      kind: "package-changed";
      path: string;
      field: "name" | "version" | "hasInstallScript";
      expected: string;
      actual: string;
    };

export type PhysicalAuditIssue =
  | { code: "orphan-package"; path: string; actual: string }
  | { code: "missing-from-disk"; path: string; expected: string }
  | {
      code: "disk-mismatch";
      path: string;
      field: "name" | "version" | "hasInstallScript";
      expected: string;
      actual: string;
    };

export interface ArtifactManifest {
  algorithm: typeof ARTIFACT_HASH_ALGORITHM;
  root: string;
  fileCount: number;
  files: Record<string, string>;
}

export type ArtifactDifference =
  | { kind: "file-added"; path: string; actual: string }
  | { kind: "file-removed"; path: string; expected: string }
  | { kind: "file-changed"; path: string; expected: string; actual: string };

export interface ToolchainContext {
  nodeVersion: string;
  npmVersion: string;
  platform: string;
  arch: string;
  libc?: string;
  reviewedRef: string;
  packageJsonSha256: string;
  packageLockSha256: string;
}

export interface ToolchainDifference {
  field: keyof ToolchainContext;
  expected: string;
  actual: string;
}

export const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

export function truncateValue(value: string, max = MAX_DIFF_VALUE_LENGTH): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

function canonicalRecord(value: unknown): string {
  if (value === undefined || value === null) {
    return "undefined";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const rendered = entries
    .map(([key, inner]) => `${key}=${canonicalRecord(inner)}`)
    .join(",");
  return `{${rendered}}`;
}

function canonicalizeStringList(value: unknown): Record<string, true> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, true> = {};
  for (const item of value) {
    if (typeof item === "string") {
      result[item] = true;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeEntry(raw: unknown): NormalizedPackageEntry | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const version = record.version;
  if (typeof version !== "string" || version.length === 0) {
    // Link entries without a version cannot participate in version
    // comparisons; retaining them would make every field optional.
    return null;
  }
  const entry: NormalizedPackageEntry = { version };
  if (typeof record.name === "string") entry.name = record.name;
  if (typeof record.resolved === "string") entry.resolved = record.resolved;
  if (typeof record.integrity === "string") entry.integrity = record.integrity;
  for (const flag of ["dev", "optional", "devOptional", "peer", "hasInstallScript"] as const) {
    if (record[flag] === true) entry[flag] = true;
  }
  if (isStringRecord(record.engines)) entry.engines = record.engines;
  if (isStringRecord(record.bin)) entry.bin = record.bin;
  const os = canonicalizeStringList(record.os);
  if (os) entry.os = Object.keys(os).sort();
  const cpu = canonicalizeStringList(record.cpu);
  if (cpu) entry.cpu = Object.keys(cpu).sort();
  const libc = canonicalizeStringList(record.libc);
  if (libc) entry.libc = Object.keys(libc).sort();
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    if (isStringRecord(record[field])) entry[field] = record[field];
  }
  return entry;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}

export function normalizeLockfileGraph(raw: unknown): NormalizedDependencyGraph {
  const result: NormalizedDependencyGraph = {
    lockfileVersion: null,
    root: null,
    packages: {},
  };
  if (typeof raw !== "object" || raw === null) {
    return result;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.lockfileVersion === "number" || typeof record.lockfileVersion === "string") {
    result.lockfileVersion = record.lockfileVersion;
  }
  const packages =
    typeof record.packages === "object" && record.packages !== null
      ? (record.packages as Record<string, unknown>)
      : {};
  for (const [path, rawEntry] of Object.entries(packages).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (path === "") {
      result.root = normalizeEntry(rawEntry);
      continue;
    }
    const normalized = normalizeEntry(rawEntry);
    if (normalized) {
      result.packages[path] = normalized;
    }
  }
  return result;
}

function collectGraphDifferences(
  expected: NormalizedDependencyGraph,
  actual: NormalizedDependencyGraph,
): GraphDifference[] {
  const differences: GraphDifference[] = [];
  const push = (difference: GraphDifference) => {
    differences.push(difference);
  };
  if (String(expected.lockfileVersion) !== String(actual.lockfileVersion)) {
    push({
      kind: "lockfile-version-changed",
      expected: String(expected.lockfileVersion),
      actual: String(actual.lockfileVersion),
    });
  }
  appendEntryDiffs(push, "", expected.root, actual.root, "root-changed");
  const paths = unionSorted(Object.keys(expected.packages), Object.keys(actual.packages));
  for (const path of paths) {
    const expectedEntry = expected.packages[path];
    const actualEntry = actual.packages[path];
    if (!expectedEntry) {
      push({
        kind: "package-added",
        path,
        actual: truncateValue(canonicalRecord(actualEntry)),
      });
      continue;
    }
    if (!actualEntry) {
      push({
        kind: "package-removed",
        path,
        expected: truncateValue(canonicalRecord(expectedEntry)),
      });
      continue;
    }
    appendEntryDiffs(push, path, expectedEntry, actualEntry, "package-changed");
  }
  return differences;
}

function bounded<T>(items: T[], maxDifferences: number): BoundedDiff<T> {
  return {
    total: items.length,
    shown: items.slice(0, maxDifferences),
    truncated: items.length > maxDifferences,
    maxShown: maxDifferences,
  };
}

export function compareNormalizedGraphs(
  expected: NormalizedDependencyGraph,
  actual: NormalizedDependencyGraph,
  maxDifferences = DEFAULT_MAX_DIFFERENCES,
): BoundedDiff<GraphDifference> {
  return bounded(collectGraphDifferences(expected, actual), maxDifferences);
}

const ENTRY_FIELDS = [
  "name",
  "version",
  "resolved",
  "integrity",
  "dev",
  "optional",
  "devOptional",
  "peer",
  "hasInstallScript",
  "engines",
  "os",
  "cpu",
  "libc",
  "bin",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function appendEntryDiffs(
  push: (difference: GraphDifference) => void,
  path: string,
  expectedEntry: NormalizedPackageEntry | null,
  actualEntry: NormalizedPackageEntry | null,
  changedKind: "root-changed" | "package-changed",
): void {
  const expectedRecord = expectedEntry as unknown as Record<string, unknown> | null;
  const actualRecord = actualEntry as unknown as Record<string, unknown> | null;
  for (const field of ENTRY_FIELDS) {
    const expectedValue = expectedRecord ? expectedRecord[field] : undefined;
    const actualValue = actualRecord ? actualRecord[field] : undefined;
    if (canonicalRecord(expectedValue) === canonicalRecord(actualValue)) {
      continue;
    }
    const expectedText = truncateValue(canonicalRecord(expectedValue));
    const actualText = truncateValue(canonicalRecord(actualValue));
    if (changedKind === "root-changed") {
      push({ kind: "root-changed", field, expected: expectedText, actual: actualText });
    } else {
      push({
        kind: "package-changed",
        path,
        field,
        expected: expectedText,
        actual: actualText,
      });
    }
  }
}

function unionSorted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

function platformExcludes(
  entry: NormalizedPackageEntry,
  platform: PlatformContext,
): boolean {
  if (entry.os && entry.os.length > 0 && !entry.os.includes(platform.os)) {
    return true;
  }
  if (entry.cpu && entry.cpu.length > 0 && !entry.cpu.includes(platform.cpu)) {
    return true;
  }
  if (
    entry.libc &&
    entry.libc.length > 0 &&
    platform.libc !== undefined &&
    !entry.libc.includes(platform.libc)
  ) {
    return true;
  }
  return false;
}

function computeExpectedAbsentPaths(
  graph: NormalizedDependencyGraph,
  platform: PlatformContext,
): Set<string> {
  const expectedAbsent = new Set<string>();
  const paths = Object.keys(graph.packages).sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const entry = graph.packages[path];
    const lastNodeModules = path.lastIndexOf("node_modules/");
    const parentPath = lastNodeModules > 0 ? path.slice(0, lastNodeModules - 1) : null;
    const excludedByAncestor = parentPath !== null && expectedAbsent.has(parentPath);
    const directlyExcluded =
      entry.optional === true &&
      (platformExcludes(entry, platform) || entry.engines !== undefined);
    // Anything nested under a path that will not be installed cannot be on
    // disk either, regardless of its own optional flag.
    if (excludedByAncestor || directlyExcluded) {
      expectedAbsent.add(path);
    }
  }
  return expectedAbsent;
}

export interface InstallAuditResult {
  issues: BoundedDiff<Exclude<InstallAuditIssue, { code: "scope-flag-drift" }>>;
  scopeFlagDrift: BoundedDiff<Extract<InstallAuditIssue, { code: "scope-flag-drift" }>>;
}

export function auditInstalledGraphAgainstLockfile(
  reviewed: NormalizedDependencyGraph,
  installed: NormalizedDependencyGraph,
  platform: PlatformContext,
  maxDifferences = DEFAULT_MAX_DIFFERENCES,
): InstallAuditResult {
  const issues: InstallAuditIssue[] = [];
  const scopeDrift: InstallAuditIssue[] = [];
  const push = (issue: InstallAuditIssue) => {
    if (issue.code === "scope-flag-drift") {
      scopeDrift.push(issue);
    } else {
      issues.push(issue);
    }
  };
  const expectedAbsent = computeExpectedAbsentPaths(reviewed, platform);
  const reviewedPaths = Object.keys(reviewed.packages).sort((a, b) => a.localeCompare(b));
  const installedPaths = Object.keys(installed.packages).sort((a, b) => a.localeCompare(b));
  for (const path of reviewedPaths) {
    const reviewedEntry = reviewed.packages[path];
    const expectedInstalledEntry = installed.packages[path];
    if (expectedAbsent.has(path)) {
      // A platform-gated optional package that must not install on this
      // platform is still expected to be absent from the installed graph; if
      // npm installed it anyway, that is an unexpected resolution change.
      if (expectedInstalledEntry) {
        push({
          code: "unexpected-package",
          path,
          actual: `${expectedInstalledEntry.name ?? ""}@${expectedInstalledEntry.version}`,
        });
      }
      continue;
    }
    const installedEntry = expectedInstalledEntry;
    if (!installedEntry) {
      push({
        code: "missing-package",
        path,
        expected: `${reviewedEntry.name ?? ""}@${reviewedEntry.version}`,
      });
      continue;
    }
    if ((reviewedEntry.name ?? undefined) !== (installedEntry.name ?? undefined)) {
      push({
        code: "name-mismatch",
        path,
        expected: reviewedEntry.name ?? "",
        actual: installedEntry.name ?? "",
      });
    }
    if (reviewedEntry.version !== installedEntry.version) {
      push({
        code: "version-mismatch",
        path,
        expected: reviewedEntry.version,
        actual: installedEntry.version,
      });
    }
    if ((reviewedEntry.integrity ?? undefined) !== (installedEntry.integrity ?? undefined)) {
      push({
        code: "integrity-mismatch",
        path,
        expected: reviewedEntry.integrity ?? "",
        actual: installedEntry.integrity ?? "",
      });
    }
    if ((reviewedEntry.resolved ?? undefined) !== (installedEntry.resolved ?? undefined)) {
      push({
        code: "resolved-mismatch",
        path,
        expected: reviewedEntry.resolved ?? "",
        actual: installedEntry.resolved ?? "",
      });
    }
    if (
      (reviewedEntry.hasInstallScript === true) !== (installedEntry.hasInstallScript === true)
    ) {
      push({
        code: "install-script-drift",
        path,
        expected: reviewedEntry.hasInstallScript === true,
        actual: installedEntry.hasInstallScript === true,
      });
    }
    if ((reviewedEntry.peer === true) !== (installedEntry.peer === true)) {
      push({
        code: "install-flag-mismatch",
        path,
        field: "peer",
        expected: reviewedEntry.peer === true,
        actual: installedEntry.peer === true,
      });
    }
    for (const flag of ["optional", "dev", "devOptional"] as const) {
      if (
        flag === "dev" &&
        (reviewedEntry.devOptional === true || installedEntry.devOptional === true)
      ) {
        // devOptional reachability subsumes dev reachability: when either
        // snapshot marks the package devOptional, a dev difference is the
        // same bookkeeping drift and must not be reported twice.
        continue;
      }
      if ((reviewedEntry[flag] === true) !== (installedEntry[flag] === true)) {
        push({
          code: "scope-flag-drift",
          path,
          field: flag,
          expected: reviewedEntry[flag] === true,
          actual: installedEntry[flag] === true,
        });
      }
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const expectedEdges = reviewedEntry[field] ?? {};
      const actualEdges = installedEntry[field] ?? {};
      if (canonicalRecord(expectedEdges) !== canonicalRecord(actualEdges)) {
        push({
          code: "dependency-edge-mismatch",
          path,
          field,
          expected: truncateValue(canonicalRecord(expectedEdges)),
          actual: truncateValue(canonicalRecord(actualEdges)),
        });
      }
    }
  }
  for (const path of installedPaths) {
    if (!reviewed.packages[path]) {
      const installedEntry = installed.packages[path];
      push({
        code: "unexpected-package",
        path,
        actual: `${installedEntry.name ?? ""}@${installedEntry.version}`,
      });
    }
  }
  return {
    issues: bounded(
      issues as Array<Exclude<InstallAuditIssue, { code: "scope-flag-drift" }>>,
      maxDifferences,
    ),
    scopeFlagDrift: bounded(
      scopeDrift as Array<Extract<InstallAuditIssue, { code: "scope-flag-drift" }>>,
      maxDifferences,
    ),
  };
}

export function compareInstalledScans(
  expected: Record<string, InstalledPackageRecord>,
  actual: Record<string, InstalledPackageRecord>,
  maxDifferences = DEFAULT_MAX_DIFFERENCES,
): BoundedDiff<ScanDifference> {
  const differences: ScanDifference[] = [];
  const push = (difference: ScanDifference) => {
    if (differences.length < maxDifferences) differences.push(difference);
  };
  const paths = unionSorted(Object.keys(expected), Object.keys(actual));
  for (const path of paths) {
    const expectedEntry = expected[path];
    const actualEntry = actual[path];
    if (!actualEntry) {
      push({
        kind: "package-removed",
        path,
        expected: `${expectedEntry.name}@${expectedEntry.version}`,
      });
      continue;
    }
    if (!expectedEntry) {
      push({
        kind: "package-added",
        path,
        actual: `${actualEntry.name}@${actualEntry.version}`,
      });
      continue;
    }
    for (const field of ["name", "version", "hasInstallScript"] as const) {
      if (String(expectedEntry[field]) !== String(actualEntry[field])) {
        push({
          kind: "package-changed",
          path,
          field,
          expected: String(expectedEntry[field]),
          actual: String(actualEntry[field]),
        });
      }
    }
  }
  return bounded(differences, maxDifferences);
}

function packageNameFromPath(path: string): string {
  const afterNodeModules = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const segments = afterNodeModules.split("/");
  if (segments[0].startsWith("@")) {
    return `${segments[0]}/${segments[1] ?? ""}`;
  }
  return segments[0];
}

export function auditPhysicalScanAgainstHiddenLockfile(
  scan: Record<string, InstalledPackageRecord>,
  hidden: NormalizedDependencyGraph,
  maxDifferences = DEFAULT_MAX_DIFFERENCES,
): BoundedDiff<PhysicalAuditIssue> {
  const issues: PhysicalAuditIssue[] = [];
  const push = (issue: PhysicalAuditIssue) => {
    if (issues.length < maxDifferences) issues.push(issue);
  };
  const paths = unionSorted(Object.keys(scan), Object.keys(hidden.packages));
  for (const path of paths) {
    const scanEntry = scan[path];
    const lockEntry = hidden.packages[path];
    if (scanEntry && !lockEntry) {
      push({
        code: "orphan-package",
        path,
        actual: `${scanEntry.name}@${scanEntry.version}`,
      });
      continue;
    }
    if (lockEntry && !scanEntry) {
      push({
        code: "missing-from-disk",
        path,
        expected: `${lockEntry.name ?? ""}@${lockEntry.version}`,
      });
      continue;
    }
    if (!scanEntry || !lockEntry) {
      continue;
    }
    const expectedName = lockEntry.name ?? packageNameFromPath(path);
    if (scanEntry.name !== expectedName) {
      push({
        code: "disk-mismatch",
        path,
        field: "name",
        expected: expectedName,
        actual: scanEntry.name,
      });
    }
    if (scanEntry.version !== lockEntry.version) {
      push({
        code: "disk-mismatch",
        path,
        field: "version",
        expected: lockEntry.version,
        actual: scanEntry.version,
      });
    }
    if (scanEntry.hasInstallScript !== (lockEntry.hasInstallScript === true)) {
      push({
        code: "disk-mismatch",
        path,
        field: "hasInstallScript",
        expected: String(lockEntry.hasInstallScript === true),
        actual: String(scanEntry.hasInstallScript),
      });
    }
  }
  return bounded(issues, maxDifferences);
}

export function compareArtifactManifests(
  expected: ArtifactManifest,
  actual: ArtifactManifest,
  maxDifferences = DEFAULT_MAX_DIFFERENCES,
): BoundedDiff<ArtifactDifference> {
  const differences: ArtifactDifference[] = [];
  const push = (difference: ArtifactDifference) => {
    if (differences.length < maxDifferences) differences.push(difference);
  };
  const paths = unionSorted(Object.keys(expected.files), Object.keys(actual.files));
  for (const path of paths) {
    const expectedHash = expected.files[path];
    const actualHash = actual.files[path];
    if (expectedHash === undefined) {
      push({ kind: "file-added", path, actual: actualHash });
    } else if (actualHash === undefined) {
      push({ kind: "file-removed", path, expected: expectedHash });
    } else if (expectedHash !== actualHash) {
      push({ kind: "file-changed", path, expected: expectedHash, actual: actualHash });
    }
  }
  return bounded(differences, maxDifferences);
}

/**
 * Extracts the major version from simple engines.node patterns ("22", "22.x",
 * "^22.0.0", ">=20"). Returns null for patterns this check does not evaluate.
 */
export function enginesNodeMajor(engineSpec: string | null): number | null {
  if (!engineSpec) return null;
  const match = engineSpec.trim().match(/^(?:\^|>=|~)?(\d+)(?:\.(?:\d+|x))?(?:\.(?:\d+|x))?$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function compareToolchains(
  expected: ToolchainContext,
  actual: ToolchainContext,
): ToolchainDifference[] {
  const differences: ToolchainDifference[] = [];
  for (const field of Object.keys(expected) as Array<keyof ToolchainContext>) {
    const expectedValue = expected[field] ?? "";
    const actualValue = actual[field] ?? "";
    if (expectedValue !== actualValue) {
      differences.push({ field, expected: expectedValue, actual: actualValue });
    }
  }
  return differences;
}
