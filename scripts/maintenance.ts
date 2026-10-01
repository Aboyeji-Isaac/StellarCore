import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  activateMaintenanceMode,
  deactivateMaintenanceMode,
  getMaintenanceStatus,
} from "@/lib/maintenance";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  let result;

  if (command === "status") {
    result = await getMaintenanceStatus();
  } else if (command === "activate") {
    result = await activateMaintenanceMode(
      process.env.STELLARCORE_MAINTENANCE_REASON ?? "",
      process.env.STELLARCORE_MAINTENANCE_OPERATOR ?? "",
    );
  } else if (command === "deactivate") {
    result = await deactivateMaintenanceMode(
      process.env.STELLARCORE_MAINTENANCE_OPERATOR ?? "",
    );
  } else {
    process.stderr.write(
      "Usage: npm run maintenance -- status|activate|deactivate\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;

  const { db } = await import("@/lib/dbClient");
  await db.$disconnect();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        error: { code: "MAINTENANCE_COMMAND_FAILED" },
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
