import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_DIFFERENCES,
  type InstalledPackageRecord,
  type NormalizedDependencyGraph,
  type NormalizedPackageEntry,
  auditInstalledGraphAgainstLockfile,
  auditPhysicalScanAgainstHiddenLockfile,
  compareArtifactManifests,
  compareInstalledScans,
  compareNormalizedGraphs,
  compareToolchains,
  enginesNodeMajor,
  normalizeLockfileGraph,
  truncateValue,
} from "@/lib/tooling/installReproducibility";

const LINUX_X64_GLIBC = { os: "linux", cpu: "x64", libc: "glibc" };
const DARWIN_ARM64 = { os: "darwin", cpu: "arm64" };

function entry(overrides: Partial<NormalizedPackageEntry> = {}): NormalizedPackageEntry {
  return {
    version: "1.0.0",
    resolved: "https://registry.example.com/pkg/-/pkg-1.0.0.tgz",
    integrity: "sha512-abc",
    ...overrides,
  };
}

function graph(
  packages: Record<string, NormalizedPackageEntry>,
  overrides: Partial<NormalizedDependencyGraph> = {},
): NormalizedDependencyGraph {
  return { lockfileVersion: 3, root: null, packages, ...overrides };
}

function pkg(name: string, version: string, extra: Partial<InstalledPackageRecord> = {}) {
  return { name, version, hasInstallScript: false, ...extra };
}

const fixtureLockfile = {
  lockfileVersion: 3,
  name: "stellarcore",
  packages: {
    "": {
      name: "stellarcore",
      version: "0.1.0",
      dependencies: { pkg: "^1.0.0" },
    },
    "node_modules/pkg": {
      version: "1.2.3",
      resolved: "https://registry.example.com/pkg/-/pkg-1.2.3.tgz",
      integrity: "sha512-xyz",
      funding: [{ type: "opencollective", url: "https://example.com" }],
      dependencies: { leftPad: "^2.0.0", zebra: "^1.0.0" },
    },
    "node_modules/left-pad": { version: "2.1.0" },
    "node_modules/zebra": { version: "1.9.0" },
  },
};

test("normalizeLockfileGraph keeps graph-relevant fields and drops the rest", () => {
  const normalized = normalizeLockfileGraph(fixtureLockfile);
  assert.equal(normalized.lockfileVersion, 3);
  assert.equal(normalized.root?.name, "stellarcore");
  const pkgEntry = normalized.packages["node_modules/pkg"];
  assert.equal(pkgEntry.version, "1.2.3");
  assert.equal(pkgEntry.integrity, "sha512-xyz");
  assert.deepEqual(pkgEntry.dependencies, { leftPad: "^2.0.0", zebra: "^1.0.0" });
  assert.equal("funding" in pkgEntry, false);
});

test("normalization never hides package or version changes", () => {
  const base = graph({
    "node_modules/pkg": entry(),
    "node_modules/other": entry({ version: "3.0.0" }),
  });
  const changedVersion = graph({
    "node_modules/pkg": entry({ version: "9.9.9" }),
    "node_modules/other": entry({ version: "3.0.0" }),
  });
  const changedIntegrity = graph({
    "node_modules/pkg": entry({ integrity: "sha512-tampered" }),
    "node_modules/other": entry({ version: "3.0.0" }),
  });
  const changedResolved = graph({
    "node_modules/pkg": entry({ resolved: "https://evil.example.com/pkg.tgz" }),
    "node_modules/other": entry({ version: "3.0.0" }),
  });
  assert.equal(
    compareNormalizedGraphs(base, changedVersion).shown.some(
      (difference) =>
        difference.kind === "package-changed" &&
        difference.path === "node_modules/pkg" &&
        difference.field === "version",
    ),
    true,
  );
  assert.equal(
    compareNormalizedGraphs(base, changedIntegrity).shown.some(
      (difference) =>
        difference.kind === "package-changed" && difference.field === "integrity",
    ),
    true,
  );
  assert.equal(
    compareNormalizedGraphs(base, changedResolved).shown.some(
      (difference) =>
        difference.kind === "package-changed" && difference.field === "resolved",
    ),
    true,
  );
});

test("compareNormalizedGraphs is order-insensitive and detects drift", () => {
  const a = graph({
    "node_modules/a": entry(),
    "node_modules/b": entry({ version: "2.0.0" }),
  });
  const aReordered = graph({
    "node_modules/b": entry({ version: "2.0.0" }),
    "node_modules/a": entry(),
  });
  assert.equal(compareNormalizedGraphs(a, aReordered).total, 0);

  const added = graph({
    ...a.packages,
    "node_modules/c": entry(),
  });
  const removed = graph({ "node_modules/a": entry() });
  assert.equal(
    compareNormalizedGraphs(a, added).shown.some(
      (difference) =>
        difference.kind === "package-added" && difference.path === "node_modules/c",
    ),
    true,
  );
  assert.equal(
    compareNormalizedGraphs(a, removed).shown.some(
      (difference) =>
        difference.kind === "package-removed" && difference.path === "node_modules/b",
    ),
    true,
  );
});

test("compareNormalizedGraphs detects lifecycle-script and edge drift", () => {
  const a = graph({
    "node_modules/pkg": entry({ dependencies: { helper: "^1.0.0" } }),
  });
  const withInstallScript = graph({
    "node_modules/pkg": entry({
      dependencies: { helper: "^1.0.0" },
      hasInstallScript: true,
    }),
  });
  const withNewEdge = graph({
    "node_modules/pkg": entry({ dependencies: { helper: "^1.0.0", extra: "^1.0.0" } }),
  });
  assert.equal(
    compareNormalizedGraphs(a, withInstallScript).shown.some(
      (difference) =>
        difference.kind === "package-changed" && difference.field === "hasInstallScript",
    ),
    true,
  );
  assert.equal(
    compareNormalizedGraphs(a, withNewEdge).shown.some(
      (difference) =>
        difference.kind === "package-changed" && difference.field === "dependencies",
    ),
    true,
  );
});

test("compareNormalizedGraphs bounds its diff output", () => {
  const base = graph({
    "node_modules/a": entry(),
    "node_modules/b": entry(),
    "node_modules/c": entry(),
  });
  const changed = graph({
    "node_modules/a": entry({ version: "2.0.0" }),
    "node_modules/b": entry({ version: "2.0.0" }),
    "node_modules/c": entry({ version: "2.0.0" }),
  });
  const result = compareNormalizedGraphs(base, changed, 2);
  assert.equal(result.total, 3);
  assert.equal(result.shown.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.maxShown, 2);
  assert.equal(DEFAULT_MAX_DIFFERENCES, 50);
});

test("auditInstalledGraphAgainstLockfile accepts an install that matches the reviewed lockfile", () => {
  const reviewed = graph({
    "node_modules/pkg": entry(),
    "node_modules/pkg-cli": entry({ version: "0.5.0" }),
  });
  const installed = graph({
    "node_modules/pkg": entry(),
    "node_modules/pkg-cli": entry({ version: "0.5.0" }),
  });
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(result.issues.total, 0);
  assert.equal(result.scopeFlagDrift.total, 0);
});

test("audit reports version, integrity, script, and unexpected-package drift", () => {
  const reviewed = graph({
    "node_modules/pkg": entry(),
    "node_modules/old": entry({ version: "1.0.0", hasInstallScript: false }),
  });
  const installed = graph({
    "node_modules/pkg": entry({ integrity: "sha512-different" }),
    "node_modules/old": entry({ version: "1.0.0", hasInstallScript: true }),
    "node_modules/surprise": entry({ version: "6.6.6" }),
  });
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  const codes = result.issues.shown.map((issue) => issue.code);
  assert.ok(codes.includes("integrity-mismatch"));
  assert.ok(codes.includes("install-script-drift"));
  assert.ok(codes.includes("unexpected-package"));
  assert.equal(codes.includes("version-mismatch"), false);
});

test("platform-incompatible optional packages are expected to be absent", () => {
  const reviewed = graph({
    "node_modules/roll-native": entry({
      optional: true,
      os: ["darwin"],
      cpu: ["arm64"],
    }),
    "node_modules/roll-native/node_modules/deep-dep": entry({ optional: true }),
    "node_modules/regular": entry(),
  });
  const installed = graph({ "node_modules/regular": entry() });
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(result.issues.total, 0);
});

test("optional packages with engines metadata still install when platform gates match", () => {
  const reviewed = graph({
    "node_modules/native-with-engines": entry({
      optional: true,
      engines: { node: ">=18" },
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    }),
  });
  const installed = graph({
    "node_modules/native-with-engines": entry({
      engines: { node: ">=18" },
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    }),
  });
  const result = auditInstalledGraphAgainstLockfile(
    reviewed,
    installed,
    LINUX_X64_GLIBC,
  );
  assert.equal(result.issues.total, 0);
});

test("optional packages without platform gates must still install", () => {
  const reviewed = graph({
    "node_modules/fallback-wasi": entry({ optional: true }),
  });
  const installed = graph({});
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(result.issues.total, 1);
  assert.equal(result.issues.shown[0]?.code, "missing-package");
  assert.equal(result.issues.shown[0]?.path, "node_modules/fallback-wasi");
});

test("optional packages absent on other platforms still install when the platform matches", () => {
  const reviewed = graph({
    "node_modules/darwin-only": entry({ optional: true, os: ["darwin"], cpu: ["arm64"] }),
  });
  const installed = graph({ "node_modules/darwin-only": entry() });
  const linux = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(linux.issues.total, 1);
  assert.equal(linux.issues.shown[0]?.code, "unexpected-package");
  const darwin = auditInstalledGraphAgainstLockfile(reviewed, installed, DARWIN_ARM64);
  assert.equal(darwin.issues.total, 0);
});

test("dev/devOptional scope drift is recorded separately and never fatal", () => {
  const reviewed = graph({
    "node_modules/types": entry({ devOptional: true }),
  });
  const installed = graph({
    "node_modules/types": entry({ dev: true }),
  });
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(result.issues.total, 0);
  assert.equal(result.scopeFlagDrift.total, 1);
  assert.equal(result.scopeFlagDrift.shown[0]?.field, "devOptional");
});

test("optional and peer flag drift is fatal", () => {
  const reviewed = graph({
    "node_modules/pkg": entry({ peer: true }),
  });
  const installed = graph({
    "node_modules/pkg": entry(),
  });
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC);
  assert.equal(result.issues.total, 1);
  assert.equal(result.issues.shown[0]?.code, "install-flag-mismatch");
});

test("audit bounds fatal issues and scope drift independently", () => {
  const reviewed = graph(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `node_modules/p${index}`,
        entry({ integrity: "sha512-reviewed" }),
      ]),
    ),
  );
  const installed = graph(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `node_modules/p${index}`,
        entry({ integrity: "sha512-installed", dev: true }),
      ]),
    ),
  );
  const result = auditInstalledGraphAgainstLockfile(reviewed, installed, LINUX_X64_GLIBC, 2);
  assert.equal(result.issues.total, 6);
  assert.equal(result.issues.shown.length, 2);
  assert.equal(result.scopeFlagDrift.total, 6);
  assert.equal(result.scopeFlagDrift.shown.length, 2);
});

test("compareInstalledScans detects layout drift", () => {
  const a = { "node_modules/a": pkg("a", "1.0.0") };
  const b = {
    "node_modules/a": pkg("a", "1.1.0"),
    "node_modules/b": pkg("b", "1.0.0"),
  };
  const diff = compareInstalledScans(a, b);
  assert.equal(diff.total, 2);
  assert.deepEqual(
    diff.shown.map((difference) => difference.kind).sort(),
    ["package-added", "package-changed"],
  );
});

test("auditPhysicalScanAgainstHiddenLockfile derives scoped names from paths", () => {
  const hidden = graph({
    "node_modules/@scope/thing": { version: "2.0.0" },
    "node_modules/plain": { version: "1.0.0" },
  });
  const scan = {
    "node_modules/@scope/thing": pkg("@scope/thing", "2.0.0"),
    "node_modules/plain": pkg("plain", "1.0.0"),
  };
  const result = auditPhysicalScanAgainstHiddenLockfile(scan, hidden);
  assert.equal(result.total, 0);
});

test("auditPhysicalScanAgainstHiddenLockfile reports orphans, missing, and mismatches", () => {
  const hidden = graph({
    "node_modules/kept": { version: "1.0.0" },
    "node_modules/gone": { version: "1.0.0" },
  });
  const scan = {
    "node_modules/kept": pkg("kept", "9.9.9"),
    "node_modules/orphan": pkg("orphan", "1.0.0"),
  };
  const result = auditPhysicalScanAgainstHiddenLockfile(scan, hidden);
  const codes = result.shown.map((issue) => issue.code).sort();
  assert.deepEqual(codes, ["disk-mismatch", "missing-from-disk", "orphan-package"]);
});

test("compareArtifactManifests detects added, removed, and changed files", () => {
  const a = {
    algorithm: "sha256" as const,
    root: "app/generated/prisma",
    fileCount: 2,
    files: { "index.d.ts": "hash-a", "runtime.js": "hash-b" },
  };
  const b = {
    algorithm: "sha256" as const,
    root: "app/generated/prisma",
    fileCount: 2,
    files: { "index.d.ts": "hash-a2", "runtime.js": "hash-b" },
  };
  assert.equal(compareArtifactManifests(a, a).total, 0);
  const changed = compareArtifactManifests(a, b);
  assert.equal(changed.total, 1);
  assert.equal(changed.shown[0]?.kind, "file-changed");

  const added = compareArtifactManifests(a, {
    ...b,
    files: { ...b.files, "extra.js": "hash-c" },
  });
  assert.equal(added.shown.some((difference) => difference.kind === "file-added"), true);
  const removed = compareArtifactManifests(a, {
    algorithm: "sha256",
    root: "app/generated/prisma",
    fileCount: 1,
    files: { "runtime.js": "hash-b" },
  });
  assert.equal(removed.shown.some((difference) => difference.kind === "file-removed"), true);
});

test("compareToolchains records every difference between run toolchains", () => {
  const base = {
    nodeVersion: "v22.14.0",
    npmVersion: "10.9.2",
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    reviewedRef: "HEAD",
    packageJsonSha256: "aaa",
    packageLockSha256: "bbb",
  };
  assert.deepEqual(compareToolchains(base, base), []);
  const different = compareToolchains(base, { ...base, npmVersion: "11.0.0" });
  assert.equal(different.length, 1);
  assert.equal(different[0]?.field, "npmVersion");
});

test("enginesNodeMajor handles common patterns and refuses others", () => {
  assert.equal(enginesNodeMajor("22.x"), 22);
  assert.equal(enginesNodeMajor(">=20"), 20);
  assert.equal(enginesNodeMajor("^22.0.0"), 22);
  assert.equal(enginesNodeMajor("18"), 18);
  assert.equal(enginesNodeMajor("||"), null);
  assert.equal(enginesNodeMajor(null), null);
});

test("truncateValue bounds long values with an explicit marker", () => {
  const long = "x".repeat(500);
  const truncated = truncateValue(long, 100);
  assert.ok(truncated.startsWith("x".repeat(100)));
  assert.ok(truncated.includes("[truncated 400 chars]"));
  assert.equal(truncateValue("short", 100), "short");
});
