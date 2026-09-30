import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { exportEvidence, createPrismaExportDependencies } from "@/lib/export";

interface ExportArgs {
  start: string;
  end: string;
  anchorSlugs?: string[];
  corridorSlugs?: string[];
  output: string;
  exportedBy?: string;
}

function parseExportArgs(): ExportArgs {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      start: { type: "string", short: "s" },
      end: { type: "string", short: "e" },
      anchor: { type: "string", multiple: true },
      corridor: { type: "string", multiple: true },
      output: { type: "string", short: "o" },
      exportedBy: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.includes("help")) {
    printUsage();
    process.exit(0);
  }

  if (!values.start || !values.end || !values.output) {
    console.error("Error: --start, --end, and --output are required");
    printUsage();
    process.exit(1);
  }

  return {
    start: values.start,
    end: values.end,
    anchorSlugs: values.anchor,
    corridorSlugs: values.corridor,
    output: resolve(values.output),
    exportedBy: values.exportedBy ?? process.env.USER ?? "unknown",
  };
}

function printUsage(): void {
  console.log(`
Usage: npm run export:evidence -- --start <ISO_DATE> --end <ISO_DATE> --output <DIR> [options]

Required:
  -s, --start <ISO_DATE>      Start of time range (inclusive)
  -e, --end <ISO_DATE>        End of time range (inclusive)
  -o, --output <DIR>          Output directory for export package

Optional:
  --anchor <SLUG>             Filter by anchor slug (can repeat)
  --corridor <SLUG>           Filter by corridor slug (can repeat)
  --exportedBy <NAME>         Override exporter identity (default: current user)
  -h, --help                  Show this help

Example:
  npm run export:evidence -- --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z --output ./export-jan-2026 --anchor moneygram
`);
}

async function main(): Promise<void> {
  const args = parseExportArgs();

  console.log("Creating export dependencies...");
  const deps = await createPrismaExportDependencies();

  const selection = {
    timeRange: { start: args.start, end: args.end },
    anchorSlugs: args.anchorSlugs,
    corridorSlugs: args.corridorSlugs,
  };

  console.log(`Exporting evidence for ${args.start} to ${args.end}...`);
  if (args.anchorSlugs?.length) {
    console.log(`  Anchor filter: ${args.anchorSlugs.join(", ")}`);
  }
  if (args.corridorSlugs?.length) {
    console.log(`  Corridor filter: ${args.corridorSlugs.join(", ")}`);
  }

  const result = await exportEvidence(deps, selection, args.output, args.exportedBy);

  if (!result.ok) {
    console.error(`Export failed: ${result.code} - ${result.message}`);
    process.exit(1);
  }

  console.log(`Export successful!`);
  console.log(`  Output: ${result.outputPath}`);
  console.log(`  Root SHA256: ${result.manifest.rootSha256}`);
  console.log(`  Registry: ${result.manifest.registry.recordCount} records (${result.manifest.registry.byteLength} bytes)`);
  console.log(`  Evidence: ${result.manifest.evidence.recordCount} records (${result.manifest.evidence.byteLength} bytes)`);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});