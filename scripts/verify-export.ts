import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  formatVerificationResult,
  verifyExportPackage,
} from "@/lib/export";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    package: { type: "string" },
    json: { type: "boolean" },
  },
  allowPositionals: true,
});

const packageDir = values.package ?? positionals[0];
if (!packageDir) {
  process.stderr.write(
    "Usage: npm run verify:export -- --package <DIR> [--json]\n",
  );
  process.exit(1);
}

const result = await verifyExportPackage(resolve(packageDir));
process.stdout.write(
  values.json
    ? JSON.stringify(result) + "\n"
    : formatVerificationResult(result) + "\n",
);
if (!result.ok) process.exitCode = 1;
