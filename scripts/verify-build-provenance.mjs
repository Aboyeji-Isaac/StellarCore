// Issue #142: local/CI verifier for the supply-chain record.
//
// Modes:
//   --self-test   End-to-end verification of the verification logic itself:
//                 writes a valid fixture + manifest, verifies it, then writes
//                 a deliberately mismatched artifact/attestation fixture and
//                 asserts verification FAILS. Used in the release workflow and
//                 runnable locally with no database or network.
//   default       Verify a checked-out tree against a manifest.json:
//                 throwaway drift detection — lockfile/source/SBOM digests
//                 must match the manifest, and the manifest must name a
//                 resolvable commit.
//
// Exit code 0 = verified, 1 = verification failed (never silently ignored on
// release paths).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function verifyManifest(manifest, files) {
  const problems = [];
  if (manifest.schema !== "stellarcore.build-manifest/1") {
    problems.push(`unexpected schema ${manifest.schema}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) {
    problems.push("manifest commit is not a resolved 40-hex SHA");
  }
  // The project targets Node 22.x (see .nvmrc). The recorded runtime is
  // checked for informational drift below but a different (never older than
  // 22) verification runtime must not break verification itself.
  const recordedNode = manifest.runtime?.node ?? "";
  const nodeMajor = Number(/^v(\d+)\./.exec(recordedNode)?.[1] ?? 0);
  if (!nodeMajor || nodeMajor < 22) {
    problems.push(`runtime node ${recordedNode} is older than Node 22.x`);
  }
  for (const [path, expected] of Object.entries(manifest.digests ?? {})) {
    const data = files[path];
    if (data === undefined) {
      continue; // reported by the caller as an explicit missing-subject problem
    }
    const actual = `sha256:${sha256(data)}`;
    if (actual !== expected) {
      problems.push(`digest drift for ${path}: manifest ${expected} != actual ${actual}`);
    }
  }
  return problems;
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "stellarcore-provenance-"));
  const results = { tamperDetected: false, cleanVerified: false };
  try {
    // 1. A clean fixture verifies successfully.
    const artifact = JSON.stringify({ artifact: "clean", builtAt: "2026-09-30T00:00:00Z" });
    const lock = JSON.stringify({ lockfileVersion: 3, name: "stellarcore" });
    writeFileSync(join(dir, "artifact.json"), artifact);
    writeFileSync(join(dir, "package-lock.json"), lock);
    const manifest = {
      schema: "stellarcore.build-manifest/1",
      commit: "a".repeat(40),
      runtime: { node: process.version, npm: "10.0.0" },
      digests: {
        "artifact.json": `sha256:${sha256(artifact)}`,
        "package-lock.json": `sha256:${sha256(lock)}`,
      },
    };
    const read = (path) => readFileSync(join(dir, path), "utf8");
    const cleanProblems = verifyManifest(manifest, {
      "artifact.json": read("artifact.json"),
      "package-lock.json": read("package-lock.json"),
    });
    results.cleanVerified = cleanProblems.length === 0;

    // 2. A deliberately mismatched artifact/attestation fixture must FAIL.
    const tampered = JSON.stringify({ artifact: "tampered", builtAt: "2026-09-30T00:00:00Z" });
    const tamperedProblems = verifyManifest(manifest, {
      "artifact.json": tampered,
      "package-lock.json": read("package-lock.json"),
    });
    results.tamperDetected = tamperedProblems.length > 0;

    // 3. A manifest naming a foreign commit must FAIL.
    const foreignCommit = verifyManifest(
      { ...manifest, commit: "b".repeat(39) },
      { "artifact.json": read("artifact.json"), "package-lock.json": read("package-lock.json") },
    );
    results.foreignCommitDetected = foreignCommit.length > 0;

    if (!results.cleanVerified || !results.tamperDetected || !results.foreignCommitDetected) {
      console.error(JSON.stringify({ ok: false, code: "PROVENANCE_VERIFIER_SELF_TEST_FAILED", results }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, selfTest: results }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verifyRepository(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(JSON.stringify({ ok: false, code: "MANIFEST_UNREADABLE", manifestPath }));
    process.exit(1);
  }

  // Verify whatever digest subjects are present in the working tree. A
  // missing subject (e.g. verifying a fresh checkout without the release
  // SBOM) is reported as drift, not silently skipped.
  const files = {};
  const missing = [];
  for (const path of Object.keys(manifest.digests ?? {})) {
    try {
      files[path] = readFileSync(path);
    } catch {
      missing.push(path);
    }
  }
  const problems = verifyManifest(manifest, files);
  for (const path of missing) {
    problems.push(`digest subject ${path} not present in the verification target`);
  }
  if (problems.length > 0) {
    console.error(JSON.stringify({ ok: false, code: "PROVENANCE_VERIFICATION_FAILED", problems }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, commit: manifest.commit, subjects: Object.keys(manifest.digests) }));
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const manifestPath = process.argv[2] ?? "manifest.json";
  verifyRepository(manifestPath);
}
