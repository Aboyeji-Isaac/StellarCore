import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { verifyExportPackage, formatVerificationResult } from "@/lib/export";

function parseVerifyArgs(): { packageDir: string; json: boolean } {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      package: { type: "string", short: "p" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.includes("help")) {
    printUsage();
    process.exit(0);
  }

  const packageDir = values.package ?? positionals[0];
  if (!packageDir) {
    console.error("Error: package directory is required (use --package or positional argument)");
    printUsage();
    process.exit(1);
  }

  return {
    packageDir: resolve(packageDir),
    json: values.json ?? false,
  };
}

function printUsage(): void {
  console.log(`
Usage: npm run verify:export -- --package <DIR> [options]

Required:
  -p, --package <DIR>         Path to export package directory

Optional:
  --json                      Output result as JSON
  -h, --help                  Show this help

Example:
  npm run verify:export -- --package ./export-jan-2026
  npm run verify:export -- ./export-jan-2026 --json
`);
}

async function main(): Promise<void> {
  const { packageDir, json } = parseVerifyArgs();

  console.log(`Verifying export package at ${packageDir}...`);
  const result = await verifyExportPackage(packageDir);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatVerificationResult(result));
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});