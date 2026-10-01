import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateReleaseManifest } from "@/scripts/generate-release-manifest";

const ROOT = process.cwd();

test("release manifest derives SBOM components from the locked production dependency graph", () => {
  const manifest = generateReleaseManifest(manifestInput());
  const names = manifest.sbom.components.map((component) => component.name);

  // Direct production dependencies must be listed.
  assert.ok(names.includes("next"));
  assert.ok(names.includes("@prisma/client"));
  assert.ok(names.includes("smol-toml"));

  // The SBOM must include the transitive production graph, not only the root
  // dependency list.
  const lockfile = JSON.parse(readLockfile());
  const directCount = Object.keys(lockfile.packages[""].dependencies ?? {}).length;
  assert.ok(manifest.sbom.components.length > directCount);

  // Dev-only packages must never be emitted.
  assert.equal(names.includes("typescript"), false);
  assert.equal(names.includes("eslint"), false);
  assert.equal(names.includes("tsx"), false);
});

test("provenance binds the SBOM to commit, lockfile digest, and toolchain", () => {
  const input = manifestInput();
  const manifest = generateReleaseManifest(input);

  assert.equal(manifest.provenance.source.commitSha, input.commitSha);
  assert.match(manifest.provenance.lockfile.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.provenance.toolchain.node.startsWith("v"));
  assert.equal(manifest.provenance.invocationId, input.buildInvocationId);
  assert.equal(manifest.provenance.environmentId, input.environmentId);
  // SBOM digest is computed over the emitted SBOM document.
  assert.match(manifest.provenance.artifact.sbomSha256, /^[0-9a-f]{64}$/);
});

test("SBOM serial is deterministic for a given commit (reproducible CI output)", () => {
  const first = generateReleaseManifest(manifestInput());
  const second = generateReleaseManifest(manifestInput());

  // The serial derives from the commit, not wall-clock time, so repeated
  // builds of one revision produce the same identity. (The metadata timestamp
  // is informational and intentionally not compared.)
  assert.equal(first.sbom.serialNumber, second.sbom.serialNumber);
  assert.equal(first.provenance.lockfile.sha256, second.provenance.lockfile.sha256);
  // Component digests are deterministic even though the top-level sbomSha256
  // covers the timestamped document.
  assert.deepEqual(
    first.sbom.components.map((c) => c["bom-ref"]),
    second.sbom.components.map((c) => c["bom-ref"]),
  );
});

test("a changed lockfile digest changes the provenance (drift is detectable)", () => {
  const first = generateReleaseManifest(manifestInput());
  // Simulate drift by pointing the manifest at a doctored lockfile copy.
  const sandbox = join(ROOT, ".tmp-release-test");
  mkdirSync(sandbox, { recursive: true });
  const lockfile = JSON.parse(readLockfile());
  (lockfile.packages[""].dependencies ??= {}).__driftCanary = "1.0.0";
  lockfile.packages["node_modules/__driftCanary"] = { version: "1.0.0" };
  writeFileSync(join(sandbox, "package-lock.json"), JSON.stringify(lockfile));

  const drifted = generateReleaseManifest({
    repositoryRoot: sandbox,
    commitSha: "a".repeat(40),
    buildInvocationId: "run-2",
    sourceWorkflowRef: "refs/heads/drift",
    environmentId: "ci",
  });

  assert.notEqual(first.provenance.lockfile.sha256, drifted.provenance.lockfile.sha256);
  assert.ok(drifted.sbom.components.some((c) => c.name === "__driftCanary"));
  rmSync(sandbox, { recursive: true, force: true });
});

test("artifacts never contain secrets: only digests, versions, and identities", () => {
  const manifest = generateReleaseManifest(manifestInput());
  const serialized = JSON.stringify(manifest);

  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//);
  assert.doesNotMatch(serialized, /DATABASE_URL/);
  assert.doesNotMatch(serialized, /CRON_SECRET/);
  assert.doesNotMatch(serialized, /password/i);
  assert.doesNotMatch(serialized, /Bearer\s/);
});

function manifestInput() {
  return {
    repositoryRoot: ROOT,
    commitSha: "b".repeat(40),
    buildInvocationId: "run-test-1",
    sourceWorkflowRef: "refs/heads/test",
    environmentId: "ci",
  };
}

function readLockfile(): string {
  return readFileSync(join(ROOT, "package-lock.json"), "utf8");
}
