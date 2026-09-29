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
    packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
  };

  const rootPackageKey = "";
  const productionDependencies =
    lockfile.packages?.[rootPackageKey]?.dependencies ?? {};
  const applicationName = lockfile.name ?? "stellarcore";
  const applicationVersion = lockfile.version ?? "0.0.0";

  const components = Object.keys(productionDependencies)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const range = productionDependencies[name] ?? "";
      const version = resolveLockedVersion(lockfile, name, range);
      return Object.freeze({
        type: "library" as const,
        "bom-ref": `pkg:npm/${name}@${version}`,
        name,
        version,
        purl: `pkg:npm/${name}@${version}`,
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

function resolveLockedVersion(
  lockfile: { packages?: Record<string, { version?: string }> },
  name: string,
  range: string,
): string {
  // The lockfile records the exact installed version under node_modules/<name>.
  const exact = lockfile.packages?.[`node_modules/${name}`]?.version;
  if (exact) return exact;
  // Fallback for lockfiles without a root pin: use the requested range.
  return range.replace(/^[^0-9]*/, "") || "unknown";
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
