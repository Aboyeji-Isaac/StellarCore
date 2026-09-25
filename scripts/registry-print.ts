import { pathToFileURL } from "node:url";

import { formatRegistrySummary, currentRegistrySummary } from "@/lib/stellar/registryPrint";

/**
 * Read-only registry inspection. Prints a human-readable summary of the
 * checked-in anchor, corridor, and reviewed rate-source registries. This
 * script never writes: it imports only constants and pure formatting helpers,
 * touches no database, and performs no network requests.
 */
function main(): void {
  process.stdout.write(formatRegistrySummary(currentRegistrySummary()));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main();
}
