import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { computeRootHash } from "@/lib/export/canonical";
import { assertExportSafe } from "@/lib/export/safety";
import {
  EVIDENCE_EXPORT_VERSION,
  EVIDENCE_MEMBER_PATHS,
  type ExportManifest,
  type ExportManifestEntry,
  type VerificationResult,
} from "@/lib/export/types";

export async function verifyExportPackage(
  packageDir: string,
): Promise<VerificationResult> {
  try {
    const manifest = await readManifest(join(packageDir, "manifest.json"));
    if (manifest.version !== EVIDENCE_EXPORT_VERSION) {
      return Object.freeze({
        ok: false,
        code: "UNSUPPORTED_VERSION",
        message: `Unsupported evidence export version: ${manifest.version}`,
      });
    }

    const entries = validateMemberSet(manifest.members);
    const expectedRoot = computeRootHash(entries, manifest.provenance);
    if (expectedRoot !== manifest.rootSha256) {
      return Object.freeze({
        ok: false,
        code: "CORRUPTED_DATA",
        message: "Manifest root hash does not match provenance/member descriptors",
      });
    }

    for (const entry of entries) {
      const path = join(packageDir, entry.path);
      const actual = await hashFile(path);
      if (
        actual.sha256 !== entry.sha256 ||
        actual.byteLength !== entry.byteLength
      ) {
        return Object.freeze({
          ok: false,
          code: "CORRUPTED_DATA",
          message: `Member integrity mismatch: ${entry.path}`,
        });
      }

      const recordCount =
        entry.path === "registry.json"
          ? await verifyRegistry(path)
          : await verifyNdjson(path);

      if (recordCount !== entry.recordCount) {
        return Object.freeze({
          ok: false,
          code: "CORRUPTED_DATA",
          message: `Member record count mismatch: ${entry.path}`,
        });
      }
    }

    return Object.freeze({ ok: true, manifest });
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return Object.freeze({
        ok: false,
        code: "MISSING_MEMBER",
        message: "Export package is missing a required member",
      });
    }
    if (error instanceof Error && error.message === "INVALID_SCHEMA") {
      return Object.freeze({
        ok: false,
        code: "INVALID_SCHEMA",
        message: "Export package schema is invalid",
      });
    }
    if (error instanceof Error && error.message.startsWith("SECRET_DETECTED")) {
      return Object.freeze({
        ok: false,
        code: "SECRET_DETECTED",
        message: "Export package contains sensitive data",
      });
    }
    return Object.freeze({
      ok: false,
      code: "CORRUPTED_DATA",
      message: "Export package verification failed",
    });
  }
}

export function formatVerificationResult(result: VerificationResult): string {
  if (!result.ok) {
    return `Verification failed: ${result.code} - ${result.message}`;
  }
  return [
    "Verification successful",
    `Version: ${result.manifest.version}`,
    `Exported at: ${result.manifest.provenance.exportedAt}`,
    `Root SHA256: ${result.manifest.rootSha256}`,
  ].join("\n");
}

async function readManifest(path: string): Promise<ExportManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_SCHEMA");
  const manifest = parsed as Partial<ExportManifest>;
  if (
    typeof manifest.version !== "string" ||
    !manifest.provenance ||
    typeof manifest.provenance !== "object" ||
    !Array.isArray(manifest.members) ||
    typeof manifest.rootSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.rootSha256)
  ) {
    throw new Error("INVALID_SCHEMA");
  }
  assertExportSafe(manifest.provenance);
  return manifest as ExportManifest;
}

function validateMemberSet(
  entries: readonly ExportManifestEntry[],
): readonly ExportManifestEntry[] {
  if (entries.length !== EVIDENCE_MEMBER_PATHS.length) {
    throw new Error("INVALID_SCHEMA");
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.size !== entries.length) throw new Error("INVALID_SCHEMA");

  for (const expected of EVIDENCE_MEMBER_PATHS) {
    const entry = byPath.get(expected);
    if (
      !entry ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      !Number.isSafeInteger(entry.recordCount) ||
      entry.recordCount < 0
    ) {
      throw new Error("INVALID_SCHEMA");
    }
  }

  return Object.freeze(
    EVIDENCE_MEMBER_PATHS.map((path) => byPath.get(path)!),
  );
}

async function hashFile(
  path: string,
): Promise<Readonly<{ sha256: string; byteLength: number }>> {
  const metadata = await stat(path);
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return Object.freeze({
    sha256: hash.digest("hex"),
    byteLength: metadata.size,
  });
}

async function verifyRegistry(path: string): Promise<number> {
  const registry = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!registry || typeof registry !== "object") {
    throw new Error("INVALID_SCHEMA");
  }

  const value = registry as Record<string, unknown>;
  if (
    !Array.isArray(value.anchors) ||
    !Array.isArray(value.corridors) ||
    !Array.isArray(value.anchorCorridors)
  ) {
    throw new Error("INVALID_SCHEMA");
  }

  assertExportSafe(registry);
  return (
    value.anchors.length +
    value.corridors.length +
    value.anchorCorridors.length
  );
}

async function verifyNdjson(path: string): Promise<number> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;

  for await (const line of lines) {
    if (line.length === 0) continue;
    const value = JSON.parse(line) as unknown;
    assertExportSafe(value);
    count += 1;
  }

  return count;
}
