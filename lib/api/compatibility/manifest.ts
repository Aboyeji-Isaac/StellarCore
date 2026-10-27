import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  CompatibilityFixture,
  ContractManifest,
} from "@/lib/api/compatibility/types";

export const DEFAULT_CONTRACT_VERSION = "v1";

export function getContractsRootDir(
  baseDir = process.cwd(),
  version = DEFAULT_CONTRACT_VERSION,
): string {
  return join(baseDir, "contracts", "api", version);
}

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function loadContractManifest(
  baseDir = process.cwd(),
  version = DEFAULT_CONTRACT_VERSION,
): ContractManifest {
  const root = getContractsRootDir(baseDir, version);
  const manifestPath = join(root, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Contract manifest not found at ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as ContractManifest;
}

export function loadAllFixtures(
  baseDir = process.cwd(),
  version = DEFAULT_CONTRACT_VERSION,
): readonly CompatibilityFixture[] {
  const root = getContractsRootDir(baseDir, version);
  const fixturesDir = join(root, "fixtures");

  if (!existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory not found at ${fixturesDir}`);
  }

  const fixtures: CompatibilityFixture[] = [];
  const domains = readdirSync(fixturesDir, { withFileTypes: true });

  for (const domain of domains) {
    if (!domain.isDirectory()) continue;
    const domainPath = join(fixturesDir, domain.name);
    const files = readdirSync(domainPath, { withFileTypes: true });

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const filePath = join(domainPath, file.name);
      const content = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as CompatibilityFixture;
      fixtures.push(Object.freeze(parsed));
    }
  }

  return Object.freeze(
    fixtures.sort((left, right) => left.name.localeCompare(right.name)),
  );
}

export function verifyManifestIntegrity(
  baseDir = process.cwd(),
  version = DEFAULT_CONTRACT_VERSION,
): Readonly<{ ok: boolean; issues: readonly string[] }> {
  const issues: string[] = [];
  const root = getContractsRootDir(baseDir, version);

  let manifest: ContractManifest;
  try {
    manifest = loadContractManifest(baseDir, version);
  } catch (error) {
    return Object.freeze({
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    });
  }

  const fixtureFilesOnDisk: string[] = [];
  const fixturesDir = join(root, "fixtures");
  if (existsSync(fixturesDir)) {
    const domains = readdirSync(fixturesDir, { withFileTypes: true });
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      const domainPath = join(fixturesDir, domain.name);
      const files = readdirSync(domainPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".json")) {
          const relativePath = relative(root, join(domainPath, file.name));
          fixtureFilesOnDisk.push(relativePath);
        }
      }
    }
  }

  const manifestFixtureMap = new Map<string, string>();
  for (const entry of manifest.fixtures) {
    manifestFixtureMap.set(entry.path, entry.sha256);
    const absPath = join(root, entry.path);
    if (!existsSync(absPath)) {
      issues.push(`Manifest references missing fixture file: ${entry.path}`);
      continue;
    }
    const content = readFileSync(absPath, "utf8");
    const actualSha = computeSha256(content);
    if (actualSha !== entry.sha256) {
      issues.push(
        `Fixture content checksum mismatch for ${entry.path}: expected ${entry.sha256}, got ${actualSha}`,
      );
    }
  }

  for (const diskFile of fixtureFilesOnDisk) {
    if (!manifestFixtureMap.has(diskFile)) {
      issues.push(`Unregistered fixture file found on disk: ${diskFile}`);
    }
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

export function writeFixtureFile(
  fixture: CompatibilityFixture,
  relativeDir: string,
  fileName: string,
  baseDir = process.cwd(),
  version = DEFAULT_CONTRACT_VERSION,
): string {
  const root = getContractsRootDir(baseDir, version);
  const targetDir = join(root, "fixtures", relativeDir);
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, fileName);
  const formatted = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(targetPath, formatted, "utf8");

  return relative(root, targetPath);
}

export function buildAndSaveManifest(
  fixturesWithRelativePaths: readonly Readonly<{
    name: string;
    path: string;
  }>[],
  options: Readonly<{
    version?: string;
    contractVersion?: string;
    reviewedBy?: string;
    reviewReason?: string;
    breakingChangesApproved?: boolean;
    baseDir?: string;
  }> = {},
): ContractManifest {
  const baseDir = options.baseDir ?? process.cwd();
  const contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;
  const root = getContractsRootDir(baseDir, contractVersion);
  mkdirSync(root, { recursive: true });

  const manifestEntries: Array<{
    name: string;
    path: string;
    sha256: string;
  }> = [];

  for (const entry of fixturesWithRelativePaths) {
    const absPath = join(root, entry.path);
    const content = readFileSync(absPath, "utf8");
    manifestEntries.push({
      name: entry.name,
      path: entry.path,
      sha256: computeSha256(content),
    });
  }

  manifestEntries.sort((a, b) => a.name.localeCompare(b.name));

  const manifest: ContractManifest = Object.freeze({
    version: options.version ?? "1.0.0",
    contractVersion,
    updatedAt: new Date().toISOString(),
    reviewedBy: options.reviewedBy ?? "StellarCore Core Team",
    reviewReason: options.reviewReason ?? "Routine compatibility baseline",
    breakingChangesApproved: options.breakingChangesApproved ?? false,
    totalFixtures: manifestEntries.length,
    fixtures: Object.freeze(manifestEntries),
  });

  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifest;
}
