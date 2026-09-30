import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

import type {
  ExportManifest,
  ExportRegistry,
  ExportEvidence,
  ExportPackage,
  VerificationResult,
} from "@/lib/export/types";
import { canonicalStringify, computeSha256FromString, computeRootHash } from "@/lib/export/canonical";
import { assertNoSecrets } from "@/lib/export/redact";

async function readJsonFile<T>(filePath: string): Promise<T> {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function verifyFileIntegrity(
  filePath: string,
  expectedSha256: string,
  expectedByteLength: number,
): Promise<void> {
  const fs = await import("node:fs/promises");
  const stats = await fs.stat(filePath);
  if (stats.size !== expectedByteLength) {
    throw new Error(
      `Byte length mismatch for ${filePath}: expected ${expectedByteLength}, got ${stats.size}`,
    );
  }
  const actualSha256 = await computeFileSha256(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `SHA256 mismatch for ${filePath}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
}

function verifyManifestStructure(manifest: unknown): manifest is ExportManifest {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }
  const m = manifest as Record<string, unknown>;
  return (
    typeof m.version === "string" &&
    m.provenance !== undefined &&
    typeof m.provenance === "object" &&
    m.registry !== undefined &&
    typeof m.registry === "object" &&
    m.evidence !== undefined &&
    typeof m.evidence === "object" &&
    typeof m.rootSha256 === "string"
  );
}

function verifyRegistryStructure(registry: unknown): registry is ExportRegistry {
  if (!registry || typeof registry !== "object") {
    return false;
  }
  const r = registry as Record<string, unknown>;
  return (
    Array.isArray(r.anchors) &&
    Array.isArray(r.corridors) &&
    Array.isArray(r.anchorCorridors)
  );
}

function verifyEvidenceStructure(evidence: unknown): evidence is ExportEvidence {
  if (!evidence || typeof evidence !== "object") {
    return false;
  }
  const e = evidence as Record<string, unknown>;
  return (
    Array.isArray(e.rateSnapshots) &&
    Array.isArray(e.transferOutcomes) &&
    Array.isArray(e.reputationScores)
  );
}

export async function verifyExportPackage(packageDir: string): Promise<VerificationResult> {
  try {
    const manifestPath = `${packageDir}/manifest.json`;
    const registryPath = `${packageDir}/registry.json`;
    const evidencePath = `${packageDir}/evidence.json`;

    const manifest = await readJsonFile<ExportManifest>(manifestPath);

    if (!verifyManifestStructure(manifest)) {
      return Object.freeze({
        ok: false,
        code: "INVALID_SCHEMA",
        message: "Manifest structure is invalid",
      });
    }

    await verifyFileIntegrity(manifestPath, manifest.rootSha256, 0);

    await verifyFileIntegrity(registryPath, manifest.registry.sha256, manifest.registry.byteLength);
    await verifyFileIntegrity(evidencePath, manifest.evidence.sha256, manifest.evidence.byteLength);

    const registry = await readJsonFile<ExportRegistry>(registryPath);
    if (!verifyRegistryStructure(registry)) {
      return Object.freeze({
        ok: false,
        code: "INVALID_SCHEMA",
        message: "Registry structure is invalid",
      });
    }

    const evidence = await readJsonFile<ExportEvidence>(evidencePath);
    if (!verifyEvidenceStructure(evidence)) {
      return Object.freeze({
        ok: false,
        code: "INVALID_SCHEMA",
        message: "Evidence structure is invalid",
      });
    }

    assertNoSecrets(registry);
    assertNoSecrets(evidence);

    const computedRegistrySha256 = computeSha256FromString(canonicalStringify(registry));
    if (computedRegistrySha256 !== manifest.registry.sha256) {
      return Object.freeze({
        ok: false,
        code: "CORRUPTED_DATA",
        message: "Registry content does not match manifest hash",
      });
    }

    const computedEvidenceSha256 = computeSha256FromString(canonicalStringify(evidence));
    if (computedEvidenceSha256 !== manifest.evidence.sha256) {
      return Object.freeze({
        ok: false,
        code: "CORRUPTED_DATA",
        message: "Evidence content does not match manifest hash",
      });
    }

    const computedRootSha256 = computeRootHash([
      { sha256: manifest.registry.sha256 },
      { sha256: manifest.evidence.sha256 },
    ]);
    if (computedRootSha256 !== manifest.rootSha256) {
      return Object.freeze({
        ok: false,
        code: "MANIFEST_MISMATCH",
        message: "Root hash does not match computed root hash",
      });
    }

    return Object.freeze({
      ok: true,
      manifest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let code: VerificationResult["code"] = "CORRUPTED_DATA";
    if (message.includes("Byte length mismatch") || message.includes("SHA256 mismatch")) {
      code = "CORRUPTED_DATA";
    } else if (message.includes("Missing") || message.includes("ENOENT")) {
      code = "MISSING_MEMBER";
    } else if (message.includes("secret") || message.includes("REDACTED")) {
      code = "SECRET_DETECTED";
    }
    return Object.freeze({
      ok: false,
      code,
      message,
    });
  }
}

export async function loadExportPackage(packageDir: string): Promise<ExportPackage> {
  const manifest = await readJsonFile<ExportManifest>(`${packageDir}/manifest.json`);
  const registry = await readJsonFile<ExportRegistry>(`${packageDir}/registry.json`);
  const evidence = await readJsonFile<ExportEvidence>(`${packageDir}/evidence.json`);

  return Object.freeze({
    manifest,
    registry,
    evidence,
  });
}

export function formatVerificationResult(result: VerificationResult): string {
  if (result.ok) {
    return `✓ Verification successful\n` +
      `  Exported at: ${result.manifest.provenance.exportedAt}\n` +
      `  Exported by: ${result.manifest.provenance.exportedBy}\n` +
      `  StellarCore version: ${result.manifest.provenance.stellarCoreVersion}\n` +
      `  Schema version: ${result.manifest.provenance.schemaVersion}\n` +
      `  Selection: ${JSON.stringify(result.manifest.provenance.selection)}\n` +
      `  Registry: ${result.manifest.registry.recordCount} records (${result.manifest.registry.byteLength} bytes)\n` +
      `  Evidence: ${result.manifest.evidence.recordCount} records (${result.manifest.evidence.byteLength} bytes)\n` +
      `  Root SHA256: ${result.manifest.rootSha256}`;
  }
  return `✗ Verification failed: ${result.code}\n  ${result.message}`;
}