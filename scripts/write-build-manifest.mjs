// Issue #142: build manifest writer for the release supply-chain record.
//
// Records the exact source revision, lockfile digest, Node/npm runtime
// versions, and SBOM digest. Provenance binding to the commit/workflow is
// produced by GitHub's signed attestations (actions/attest-build-provenance);
// this manifest carries the deterministic digests maintainers verify locally.
//
// The manifest contains digests, versions, and timestamps only — never
// environment secrets, URLs, or connection strings.
//
// Usage: node scripts/write-build-manifest.mjs <manifest-out> <sbom-path>

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [manifestPath = "manifest.json", sbomPath = "sbom/stellarcore.cdx.json"] =
  process.argv.slice(2);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const lockfileDigest = sha256File("package-lock.json");
const sbomDigest = sha256File(sbomPath);
const sourceTreeDigest = sha256File("package.json");

const manifest = {
  schema: "stellarcore.build-manifest/1",
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]),
  workflow: {
    name: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    ref: process.env.GITHUB_REF ?? null,
  },
  runtime: {
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  },
  digests: {
    "package-lock.json": `sha256:${lockfileDigest}`,
    "package.json": `sha256:${sourceTreeDigest}`,
    "sbom/stellarcore.cdx.json": `sha256:${sbomDigest}`,
  },
};

// The manifest is machine-checked to contain no environment secret values.
// The GITHUB_* variables listed here are workflow metadata the manifest
// intentionally records (name, ids, repository, ref, commit), so their own
// values are exempt; every other environment value is forbidden to appear.
const MANIFEST_RECORDED_ENV_VARS = new Set([
  "GITHUB_WORKFLOW",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
]);
for (const [name, value] of Object.entries(process.env)) {
  if (
    !MANIFEST_RECORDED_ENV_VARS.has(name) &&
    typeof value === "string" &&
    value.length >= 16 &&
    JSON.stringify(manifest).includes(value)
  ) {
    console.error(JSON.stringify({ ok: false, code: "MANIFEST_CONTAINS_ENV_SECRET", variable: name }));
    process.exit(1);
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, manifestPath, commit: manifest.commit }));
