import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createPrismaExportDependencies,
  exportEvidence,
} from "@/lib/export";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    start: { type: "string" },
    end: { type: "string" },
    anchor: { type: "string", multiple: true },
    corridor: { type: "string", multiple: true },
    output: { type: "string" },
    "exported-by": { type: "string" },
  },
});

if (!values.start || !values.end || !values.output) {
  process.stderr.write(
    "Usage: npm run export:evidence -- --start <ISO> --end <ISO> --output <DIR> [--anchor <slug>] [--corridor <slug>] [--exported-by <name>]\n",
  );
  process.exit(1);
}

const result = await exportEvidence(
  createPrismaExportDependencies(),
  {
    timeRange: {
      start: values.start,
      end: values.end,
    },
    ...(values.anchor ? { anchorSlugs: values.anchor } : {}),
    ...(values.corridor ? { corridorSlugs: values.corridor } : {}),
  },
  resolve(values.output),
  values["exported-by"] ?? process.env.USER ?? "unknown",
);

process.stdout.write(JSON.stringify(result) + "\n");

if (!result.ok) {
  process.exitCode = 1;
}