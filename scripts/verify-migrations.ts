import { resolve } from "node:path";
import {
  generateMigrationManifest,
  saveMigrationManifest,
  verifyMigrationIntegrity,
} from "../lib/migrations/integrity";

function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes("--update") || args.includes("--generate");
  const isStrict = args.includes("--strict");

  const migrationsDir = resolve(process.cwd(), "prisma/migrations");
  const manifestPath = resolve(migrationsDir, "manifest.json");

  if (isUpdate) {
    const manifest = generateMigrationManifest(migrationsDir);
    saveMigrationManifest(manifestPath, manifest);
    console.log(
      `[MIGRATION-INTEGRITY] Successfully generated manifest with ${Object.keys(manifest.migrations).length} migrations at: ${manifestPath}`,
    );
    process.exit(0);
  }

  const result = verifyMigrationIntegrity({
    migrationsDir,
    manifestPath,
    allowNewMigrations: !isStrict,
  });

  console.log("------------------------------------------------------------");
  console.log("        STELLARCORE MIGRATION FILE INTEGRITY AUDIT          ");
  console.log("------------------------------------------------------------");
  console.log(`Historical migrations audited: ${result.totalHistorical}`);
  console.log(`Successfully verified:         ${result.totalVerified}`);
  console.log(`New migrations detected:       ${result.newMigrationsCount}`);
  console.log("------------------------------------------------------------");

  for (const diag of result.diagnostics) {
    const statusIcon =
      diag.status === "OK"
        ? "[PASS]"
        : diag.status === "NEW"
          ? "[NEW]"
          : "[FAIL]";
    console.log(`${statusIcon} ${diag.path}: ${diag.message}`);
  }

  if (!result.ok) {
    console.error("------------------------------------------------------------");
    console.error("CRITICAL: Migration integrity violations detected!");
    for (const err of result.errors) {
      console.error(` - ${err}`);
    }
    console.error("Aborting production deployment before database mutation.");
    console.error("------------------------------------------------------------");
    process.exit(1);
  }

  console.log("------------------------------------------------------------");
  console.log("SUCCESS: All reviewed migration files matched their digests.");
  console.log("------------------------------------------------------------");
  process.exit(0);
}

main();
