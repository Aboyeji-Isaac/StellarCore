import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  generateReleaseManifest,
  type BuildProvenance,
  type CyclonedxSbom,
} from "@/scripts/generate-release-manifest";

/**
 * Release manifest CLI (#142).
 *
 * `npm run release:manifest` writes dist-release/stellarcore-sbom.json and
 * dist-release/stellarcore-provenance.json from the current checkout.
 * `npm run verify:release` re-verifies an artifact directory against the
 * current checkout and fails closed on any drift or secret leakage.
 */

const RELEASE_DIR = process.env.STELLARCORE_RELEASE_DIR ?? "dist-release";
const SBOM_FILE = "stellarcore-sbom.json";
const PROVENANCE_FILE = "stellarcore-provenance.json";

function commitSha(): string {
  if (process.env.STELLARCORE_COMMIT_SHA) return process.env.STELLARCORE_COMMIT_SHA;
  return runGit(["rev-parse", "HEAD"]) || "local-uncommitted";
}

function workflowRef(): string {
  return (
    process.env.STELLARCORE_WORKFLOW_REF ??
    "refs/heads/local-manual-run"
  );
}

function invocationId(): string {
  return process.env.STELLARCORE_INVOCATION_ID ?? "local";
}

function environmentId(): string {
  return process.env.STELLARCORE_ENVIRONMENT_ID ?? "local";
}

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function generate(): Promise<void> {
  const manifest = generateReleaseManifest({
    repositoryRoot: process.cwd(),
    commitSha: commitSha(),
    buildInvocationId: invocationId(),
    sourceWorkflowRef: workflowRef(),
    environmentId: environmentId(),
  });

  mkdirSync(RELEASE_DIR, { recursive: true });
  const sbomPath = join(RELEASE_DIR, SBOM_FILE);
  const provenancePath = join(RELEASE_DIR, PROVENANCE_FILE);
  writeFileSync(sbomPath, `${JSON.stringify(manifest.sbom, null, 2)}\n`);
  writeFileSync(provenancePath, `${JSON.stringify(manifest.provenance, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    sbom: sbomPath,
    provenance: provenancePath,
    lockfileSha256: manifest.provenance.lockfile.sha256,
    componentCount: manifest.sbom.components.length,
  }, null, 2));
}

async function verify(): Promise<void> {
  const failures: string[] = [];
  const sbomPath = join(RELEASE_DIR, SBOM_FILE);
  const provenancePath = join(RELEASE_DIR, PROVENANCE_FILE);

  if (!existsSync(sbomPath)) failures.push(`missing artifact: ${sbomPath}`);
  if (!existsSync(provenancePath)) failures.push(`missing artifact: ${provenancePath}`);
  if (failures.length > 0) return reportFailure(failures);

  let sbom: CyclonedxSbom;
  let provenance: BuildProvenance;
  try {
    sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as CyclonedxSbom;
    provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as BuildProvenance;
  } catch (error) {
    failures.push(`artifacts are not valid JSON: ${String(error)}`);
    return reportFailure(failures);
  }

  // 1. SBOM structure.
  if (sbom.bomFormat !== "CycloneDX") failures.push("sbom.bomFormat must be CycloneDX");
  if (sbom.specVersion !== "1.5") failures.push("sbom.specVersion must be 1.5");
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    failures.push("sbom.components must be a non-empty array");
  }

  // 2. Provenance structure and required identity fields.
  if (provenance.stellarcoreProvenanceVersion !== "v1") {
    failures.push("provenance.stellarcoreProvenanceVersion must be v1");
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.source?.commitSha ?? "")) {
    failures.push("provenance.source.commitSha must be a full git SHA");
  }
  if (!provenance.lockfile?.sha256) failures.push("provenance.lockfile.sha256 missing");
  if (!provenance.toolchain?.node) failures.push("provenance.toolchain.node missing");

  // 3. Lockfile drift: the digest must match the lockfile in this checkout.
  const currentLockDigest = sha256(readFileSync("package-lock.json", "utf8"));
  if (provenance.lockfile?.sha256 !== currentLockDigest) {
    failures.push(
      "lockfile drift: provenance digest does not match the current package-lock.json",
    );
  }

  // 4. SBOM digest recorded in provenance must match the SBOM artifact.
  const sbomDigest = sha256(JSON.stringify(sbom));
  if (provenance.artifact?.sbomSha256 !== sbomDigest) {
    failures.push("artifact drift: provenance sbomSha256 does not match the SBOM artifact");
  }

  // 5. Secret leakage scan over both artifacts.
  const artifactText = `${readFileSync(sbomPath, "utf8")}${readFileSync(provenancePath, "utf8")}`;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(artifactText)) {
      failures.push(`secret material detected in artifacts: ${pattern.label}`);
    }
  }

  if (failures.length > 0) reportFailure(failures);
  console.log(JSON.stringify({
    ok: true,
    sbom: sbomPath,
    provenance: provenancePath,
    lockfileSha256: provenance.lockfile.sha256,
    commitSha: provenance.source.commitSha,
    componentCount: sbom.components.length,
  }, null, 2));
}

const SECRET_PATTERNS: readonly { label: string; regex: RegExp }[] = [
  { label: "postgres connection string", regex: /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']*@/ },
  { label: "DATABASE_URL value", regex: /"DATABASE_URL"\s*:\s*"/ },
  { label: "bearer token", regex: /Bearer\s+[A-Za-z0-9\-_.]{20,}/ },
  { label: "CRON_SECRET value", regex: /"CRON_SECRET"\s*:\s*"/ },
  { label: "generic assignment of secret-like variable", regex: /(?:secret|password|token)\s*=\s*["'][^"']{8,}["']/i },
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportFailure(failures: readonly string[]): never {
  for (const failure of failures) {
    console.error(`RELEASE_VERIFY_FAILURE: ${failure}`);
  }
  console.error(JSON.stringify({ ok: false, failures: failures.length }));
  process.exit(1);
}

const command = process.argv[2];
if (command === "generate") void generate();
else if (command === "verify") void verify();
else {
  console.error("usage: tsx scripts/release-cli.ts <generate|verify>");
  process.exit(1);
}
