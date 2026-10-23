import { executeEndpointScenario } from "@/lib/api/compatibility/harness";
import {
  buildAndSaveManifest,
  DEFAULT_CONTRACT_VERSION,
  writeFixtureFile,
} from "@/lib/api/compatibility/manifest";
import type {
  ApiDomain,
  CompatibilityFixture,
  ContractHttpMethod,
} from "@/lib/api/compatibility/types";

export type FixtureDefinition = Readonly<{
  name: string;
  domain: ApiDomain;
  endpoint: string;
  method: ContractHttpMethod;
  expectedStatus: number;
  description: string;
  subDir: string;
  fileName: string;
}>;

export const FIXTURE_DEFINITIONS: readonly FixtureDefinition[] = Object.freeze([
  // Anchors
  {
    name: "anchors.list.success",
    domain: "anchors",
    endpoint: "GET /api/anchors",
    method: "GET",
    expectedStatus: 200,
    description: "Canonical list of anchors with sorted SEPs, corridor counts, and transfer capability",
    subDir: "anchors",
    fileName: "list-success.json",
  },
  {
    name: "anchors.list.empty",
    domain: "anchors",
    endpoint: "GET /api/anchors",
    method: "GET",
    expectedStatus: 200,
    description: "Empty anchor directory response",
    subDir: "anchors",
    fileName: "list-empty.json",
  },
  {
    name: "anchors.list.error_500",
    domain: "anchors",
    endpoint: "GET /api/anchors",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error response on anchor directory failure",
    subDir: "anchors",
    fileName: "list-error-500.json",
  },
  {
    name: "anchors.detail.success",
    domain: "anchors",
    endpoint: "GET /api/anchors/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Canonical anchor detail response with associated sorted corridors",
    subDir: "anchors",
    fileName: "detail-success.json",
  },
  {
    name: "anchors.detail.error_400",
    domain: "anchors",
    endpoint: "GET /api/anchors/:slug",
    method: "GET",
    expectedStatus: 400,
    description: "Bad request error for malformed anchor slug",
    subDir: "anchors",
    fileName: "detail-error-400.json",
  },
  {
    name: "anchors.detail.error_404",
    domain: "anchors",
    endpoint: "GET /api/anchors/:slug",
    method: "GET",
    expectedStatus: 404,
    description: "Not found error for unknown anchor slug",
    subDir: "anchors",
    fileName: "detail-error-404.json",
  },
  {
    name: "anchors.detail.error_500",
    domain: "anchors",
    endpoint: "GET /api/anchors/:slug",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error for anchor detail loading failure",
    subDir: "anchors",
    fileName: "detail-error-500.json",
  },

  // Corridors
  {
    name: "corridors.list.success",
    domain: "corridors",
    endpoint: "GET /api/corridors",
    method: "GET",
    expectedStatus: 200,
    description: "Canonical list of corridors with anchor counts and country codes",
    subDir: "corridors",
    fileName: "list-success.json",
  },
  {
    name: "corridors.list.empty",
    domain: "corridors",
    endpoint: "GET /api/corridors",
    method: "GET",
    expectedStatus: 200,
    description: "Empty corridor directory response",
    subDir: "corridors",
    fileName: "list-empty.json",
  },
  {
    name: "corridors.list.error_500",
    domain: "corridors",
    endpoint: "GET /api/corridors",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error response on corridor directory failure",
    subDir: "corridors",
    fileName: "list-error-500.json",
  },
  {
    name: "corridors.detail.success",
    domain: "corridors",
    endpoint: "GET /api/corridors/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Canonical corridor detail response with associated anchors",
    subDir: "corridors",
    fileName: "detail-success.json",
  },
  {
    name: "corridors.detail.empty_anchors",
    domain: "corridors",
    endpoint: "GET /api/corridors/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Corridor detail response with zero associated anchors",
    subDir: "corridors",
    fileName: "detail-empty-anchors.json",
  },
  {
    name: "corridors.detail.error_400",
    domain: "corridors",
    endpoint: "GET /api/corridors/:slug",
    method: "GET",
    expectedStatus: 400,
    description: "Bad request error for malformed corridor slug",
    subDir: "corridors",
    fileName: "detail-error-400.json",
  },
  {
    name: "corridors.detail.error_404",
    domain: "corridors",
    endpoint: "GET /api/corridors/:slug",
    method: "GET",
    expectedStatus: 404,
    description: "Not found error for unknown corridor slug",
    subDir: "corridors",
    fileName: "detail-error-404.json",
  },
  {
    name: "corridors.detail.error_500",
    domain: "corridors",
    endpoint: "GET /api/corridors/:slug",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error for corridor detail loading failure",
    subDir: "corridors",
    fileName: "detail-error-500.json",
  },

  // Rates
  {
    name: "rates.healthy.success",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Healthy rate response with median rate, independent sources, and observations",
    subDir: "rates",
    fileName: "healthy-success.json",
  },
  {
    name: "rates.insufficient.success",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Insufficient fresh sources response with null median rate and exclusion reasons",
    subDir: "rates",
    fileName: "insufficient-success.json",
  },
  {
    name: "rates.empty.success",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Rate response with zero observations",
    subDir: "rates",
    fileName: "empty-success.json",
  },
  {
    name: "rates.error_400_missing",
    domain: "rates",
    endpoint: "GET /api/rates",
    method: "GET",
    expectedStatus: 400,
    description: "Bad request error when corridor parameter is missing",
    subDir: "rates",
    fileName: "error-missing-corridor-400.json",
  },
  {
    name: "rates.error_400_invalid",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 400,
    description: "Bad request error when corridor slug format is invalid",
    subDir: "rates",
    fileName: "error-invalid-corridor-400.json",
  },
  {
    name: "rates.error_404",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 404,
    description: "Not found error when corridor does not exist",
    subDir: "rates",
    fileName: "error-corridor-not-found-404.json",
  },
  {
    name: "rates.error_500",
    domain: "rates",
    endpoint: "GET /api/rates?corridor=:slug",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error response on rate read failure",
    subDir: "rates",
    fileName: "error-internal-500.json",
  },

  // Reputation
  {
    name: "reputation.list.success",
    domain: "reputation",
    endpoint: "GET /api/reputation",
    method: "GET",
    expectedStatus: 200,
    description: "Canonical reputation list covering established, insufficient_evidence, and not_evaluated anchors",
    subDir: "reputation",
    fileName: "list-success.json",
  },
  {
    name: "reputation.list.empty",
    domain: "reputation",
    endpoint: "GET /api/reputation",
    method: "GET",
    expectedStatus: 200,
    description: "Empty reputation list response",
    subDir: "reputation",
    fileName: "list-empty.json",
  },
  {
    name: "reputation.list.error_500",
    domain: "reputation",
    endpoint: "GET /api/reputation",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error response on reputation list failure",
    subDir: "reputation",
    fileName: "list-error-500.json",
  },
  {
    name: "reputation.detail.established_200",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Reputation detail with established score, band, evidence outcomeCount, and metrics",
    subDir: "reputation",
    fileName: "detail-established-200.json",
  },
  {
    name: "reputation.detail.insufficient_200",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Reputation detail with insufficient_evidence state, null score/band, and non-zero evidence",
    subDir: "reputation",
    fileName: "detail-insufficient-200.json",
  },
  {
    name: "reputation.detail.not_evaluated_200",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 200,
    description: "Reputation detail with not_evaluated state and all null metrics/scores",
    subDir: "reputation",
    fileName: "detail-not-evaluated-200.json",
  },
  {
    name: "reputation.detail.error_400",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 400,
    description: "Bad request error for malformed anchor slug",
    subDir: "reputation",
    fileName: "detail-error-400.json",
  },
  {
    name: "reputation.detail.error_404",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 404,
    description: "Not found error for unknown anchor slug",
    subDir: "reputation",
    fileName: "detail-error-404.json",
  },
  {
    name: "reputation.detail.error_500",
    domain: "reputation",
    endpoint: "GET /api/reputation/:slug",
    method: "GET",
    expectedStatus: 500,
    description: "Safe internal error for anchor reputation loading failure",
    subDir: "reputation",
    fileName: "detail-error-500.json",
  },
]);

export async function updateAllContracts(
  options: Readonly<{
    baseDir?: string;
    contractVersion?: string;
    reviewedBy?: string;
    reviewReason?: string;
    breakingChangesApproved?: boolean;
  }> = {},
): Promise<{ total: number; manifestPath: string }> {
  const baseDir = options.baseDir ?? process.cwd();
  const contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;

  const entries: Array<{ name: string; path: string }> = [];

  for (const def of FIXTURE_DEFINITIONS) {
    const execution = await executeEndpointScenario(def.name);
    if (execution.status !== def.expectedStatus) {
      throw new Error(
        `Fixture execution returned unexpected status for ${def.name}: expected ${def.expectedStatus}, got ${execution.status}`,
      );
    }

    const fixture: CompatibilityFixture = Object.freeze({
      name: def.name,
      domain: def.domain,
      endpoint: def.endpoint,
      method: def.method,
      expectedStatus: def.expectedStatus,
      description: def.description,
      body: execution.body,
    });

    const relPath = writeFixtureFile(
      fixture,
      def.subDir,
      def.fileName,
      baseDir,
      contractVersion,
    );

    entries.push({ name: def.name, path: relPath });
  }

  buildAndSaveManifest(entries, {
    baseDir,
    contractVersion,
    reviewedBy: options.reviewedBy,
    reviewReason: options.reviewReason,
    breakingChangesApproved: options.breakingChangesApproved,
  });

  return {
    total: entries.length,
    manifestPath: `contracts/api/${contractVersion}/manifest.json`,
  };
}

async function runUpdateCli(): Promise<void> {
  const args = process.argv.slice(2);
  let reviewedBy = "StellarCore Core Team";
  let reviewReason = "Public API compatibility contract baseline";
  let breakingChangesApproved = false;

  for (const arg of args) {
    if (arg.startsWith("--reviewed-by=")) {
      reviewedBy = arg.slice("--reviewed-by=".length);
    } else if (arg.startsWith("--reason=")) {
      reviewReason = arg.slice("--reason=".length);
    } else if (arg === "--accept-breaking") {
      breakingChangesApproved = true;
    }
  }

  const result = await updateAllContracts({
    reviewedBy,
    reviewReason,
    breakingChangesApproved,
  });

  process.stdout.write(
    `Successfully updated ${result.total} API compatibility contracts in ${result.manifestPath}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runUpdateCli();
}
