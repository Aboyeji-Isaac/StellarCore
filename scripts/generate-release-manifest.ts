import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Release supply-chain manifest generation (#142).
 *
 * Produces two artifacts for a production build:
 *  1. A CycloneDX 1.5 JSON SBOM of the locked production dependency graph
 *     (dependencies only; devDependencies are not shipped).
 *  2. A provenance record tying the SBOM to the exact source revision
 *     (GITHUB_SHA or local HEAD), the workflow run that produced it, the
 *     Node/npm versions, and the SHA-256 digest of the package-lock.json that
 *     defined dependency identity during installation.
 *
 * The provenance record is intentionally structured data, not a signature:
 * in CI it is wrapped into a verifiable SLSA-style attestation by GitHub's
 * artifact-attestation API (actions/attest-build-provenance), which binds it
 * to the OIDC-verified workflow run. Locally it supports inspection and drift
 * checks only.
 *
 * Secrets never enter these artifacts: only paths, digests, and versions are
 * recorded. No environment variables are embedded wholesale.
 */

export type ReleaseManifestInput = Readonly<{
  repositoryRoot: string;
  commitSha: string;
  buildInvocationId: string;
  sourceWorkflowRef: string;
  environmentId: string;
}>;

export type ReleaseManifest = Readonly<{
  sbom: CyclonedxSbom;
  provenance: BuildProvenance;
}>;

export type CyclonedxSbom = Readonly<{
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: 1;
  metadata: Readonly<{
    timestamp: string;
    component: Readonly<{
      type: "application";
      name: string;
      version: string;
    }>;
  }>;
  components: readonly Readonly<{
    type: "library";
    "bom-ref": string;
    name: string;
    version: string;
    purl: string;
  }>[];
}>;

export type BuildProvenance = Readonly<{
  _type: "https://schemas.opencontainers.org/attribution/manifest/v1";
  stellarcoreProvenanceVersion: "v1";
  buildType: string;
  builder: Readonly<{ id: string }>;
  invocationId: string;
  environmentId: string;
  source: Readonly<{
    commitSha: string;
    workflowRef: string;
  }>;
  lockfile: Readonly<{
    path: "package-lock.json";
    sha256: string;
  }>;
  toolchain: Readonly<{
    node: string;
    npm: string;
  }>;
  artifact: Readonly<{
    name: "stellarcore-release-manifest";
    sbomSha256: string;
  }>;
}>;

const UUID_V4_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export function generateReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const lockfilePath = `${input.repositoryRoot}/package-lock.json`;
  const lockfileRaw = readFileSync(lockfilePath, "utf8");
  const lockfileSha256 = sha256(lockfileRaw);
  const lockfile = JSON.parse(lockfileRaw) as {
    name?: string;
    version?: string;
    packages?: Record<string, {
      name?: string;
      version?: string;
      dev?: boolean;
      devOptional?: boolean;
    }>;
  };

  const applicationName = lockfile.name ?? "stellarcore";
  const applicationVersion = lockfile.version ?? "0.0.0";

  // npm lockfile v3 marks dev-only packages with dev/devOptional. Include every
  // installed non-dev package path, not just root dependencies, so the SBOM
  // reflects the full locked production dependency graph.
  const components = Object.entries(lockfile.packages ?? {})
    .filter(([path, pkg]) =>
      path.startsWith("node_modules/") &&
      typeof pkg.version === "string" &&
      pkg.version.length > 0 &&
      pkg.dev !== true &&
      pkg.devOptional !== true,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, pkg]) => {
      const name = pkg.name ?? packageNameFromLockPath(path);
      const version = pkg.version!;
      return Object.freeze({
        type: "library" as const,
        "bom-ref": `urn:stellarcore:npm:${encodeURIComponent(path)}@${version}`,
        name,
        version,
        purl: packagePurl(name, version),
      });
    });

  const sbom: CyclonedxSbom = Object.freeze({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuidV5(input.commitSha)}`,
    version: 1,
    metadata: Object.freeze({
      timestamp: new Date().toISOString(),
      component: Object.freeze({
        type: "application" as const,
        name: applicationName,
        version: applicationVersion,
      }),
    }),
    components: Object.freeze(components),
  });

  const provenance: BuildProvenance = Object.freeze({
    _type: "https://schemas.opencontainers.org/attribution/manifest/v1",
    stellarcoreProvenanceVersion: "v1",
    buildType:
      "https://github.com/Aboyeji-Isaac/StellarCore/.github/workflows/deploy-production.yml@v1",
    builder: Object.freeze({ id: input.sourceWorkflowRef }),
    invocationId: input.buildInvocationId,
    environmentId: input.environmentId,
    source: Object.freeze({
      commitSha: input.commitSha,
      workflowRef: input.sourceWorkflowRef,
    }),
    lockfile: Object.freeze({
      path: "package-lock.json",
      sha256: lockfileSha256,
    }),
    toolchain: Object.freeze({
      node: process.version,
      npm: process.env.STELLARCORE_NPM_VERSION ?? "bundled",
    }),
    artifact: Object.freeze({
      name: "stellarcore-release-manifest",
      sbomSha256: sha256(JSON.stringify(sbom)),
    }),
  });

  return Object.freeze({ sbom, provenance });
}

function packageNameFromLockPath(path: string): string {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path;
}

function packagePurl(name: string, version: string): string {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1)}`
    : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic UUID v5-style serial for the SBOM (no randomness in CI). */
function uuidV5(name: string): string {
  const digest = createHash("sha1").update(UUID_V4_NAMESPACE).update(name).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    ((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0") + digest.slice(18, 20),
    digest.slice(20, 32),
  ].join("-");
}
