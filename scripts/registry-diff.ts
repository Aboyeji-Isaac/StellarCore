import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REGISTRY_FILES = [
  "constants/anchors.ts",
  "constants/corridors.ts",
  "constants/liveRateSources.ts",
] as const;

export type RegistryDiffSummary = Readonly<{
  reference: string;
  additions: readonly string[];
  removals: readonly string[];
  modifications: readonly string[];
}>;

export function summarizeRegistryDiff(
  reference: string,
  diff: string,
): RegistryDiffSummary {
  const additions: string[] = [];
  const removals: string[] = [];
  const modifications: string[] = [];
  let file = "";
  let removedInHunk: string[] = [];
  let addedInHunk: string[] = [];

  const flushHunk = () => {
    const paired = Math.min(removedInHunk.length, addedInHunk.length);
    for (let index = 0; index < paired; index += 1) {
      modifications.push(`${file}: ${removedInHunk[index]} -> ${addedInHunk[index]}`);
    }
    removals.push(...removedInHunk.slice(paired).map((line) => `${file}: ${line}`));
    additions.push(...addedInHunk.slice(paired).map((line) => `${file}: ${line}`));
    removedInHunk = [];
    addedInHunk = [];
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      file = line.match(/ b\/(.+)$/)?.[1] ?? "unknown file";
    } else if (line.startsWith("@@ ")) {
      flushHunk();
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      addedInHunk.push(line.slice(1).trim());
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removedInHunk.push(line.slice(1).trim());
    }
  }
  flushHunk();

  return Object.freeze({
    reference,
    additions: Object.freeze(additions),
    removals: Object.freeze(removals),
    modifications: Object.freeze(modifications),
  });
}

export function readRegistryDiff(reference = "HEAD^"): RegistryDiffSummary {
  const diff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--unified=0", reference, "--", ...REGISTRY_FILES],
    { encoding: "utf8" },
  );
  return summarizeRegistryDiff(reference, diff);
}

export function formatRegistryDiff(summary: RegistryDiffSummary): string {
  const lines = [`Registry diff against ${summary.reference}`, ""];
  appendSection(lines, "Modifications", summary.modifications);
  appendSection(lines, "Additions", summary.additions);
  appendSection(lines, "Removals", summary.removals);
  if (summary.additions.length + summary.removals.length + summary.modifications.length === 0) {
    lines.push("No registry changes found.");
  }
  return `${lines.join("\n")}\n`;
}

function appendSection(lines: string[], title: string, entries: readonly string[]): void {
  lines.push(`${title} (${entries.length})`);
  if (entries.length === 0) lines.push("  (none)");
  for (const entry of entries) lines.push(`  ${entry}`);
  lines.push("");
}

function main(): void {
  const reference = process.argv[2] ?? "HEAD^";
  process.stdout.write(formatRegistryDiff(readRegistryDiff(reference)));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) main();
