import "dotenv/config";

import { pathToFileURL } from "node:url";

import { inspectSnapshot, runDisposition } from "@/lib/rates/dispositionTool";

const USAGE = `Usage:
  npm run rates:disposition -- inspect --snapshot <uuid>
  npm run rates:disposition -- <quarantine|invalidate|supersede|release> \\
    --snapshot <uuid> --reason <CODE> --review-ref <reference> [--actor <name>] \\
    [--superseded-by <uuid>] [--note <text>] [--apply]

Without --apply the command is a dry run: it validates the request against
the database and prints the planned transition without writing anything.`;

const ACTIONS = Object.freeze({
  quarantine: "QUARANTINE",
  invalidate: "INVALIDATE",
  supersede: "SUPERSEDE",
  release: "RELEASE",
} as const);

const VALUE_FLAGS = Object.freeze({
  "--snapshot": "snapshotId",
  "--reason": "reasonCode",
  "--review-ref": "reviewReference",
  "--actor": "actor",
  "--note": "note",
  "--superseded-by": "supersededBySnapshotId",
} as const);

export function parseArguments(argv: readonly string[]):
  | Readonly<{ ok: true; command: string; apply: boolean; values: Record<string, string> }>
  | Readonly<{ ok: false }> {
  const [command, ...rest] = argv;
  if (!command) return { ok: false };
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS];
    const value = rest[index + 1];
    if (!key || value === undefined || key in values) return { ok: false };
    values[key] = value;
    index += 1;
  }
  return { ok: true, command, apply, values };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { db } = await import("@/lib/dbClient");
  try {
    if (parsed.command === "inspect") {
      const result = await inspectSnapshot(parsed.values.snapshotId ?? "");
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const action = ACTIONS[parsed.command as keyof typeof ACTIONS];
    if (!action) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const result = await runDisposition({
      ...parsed.values,
      action,
      actor: parsed.values.actor ?? process.env.GITHUB_ACTOR,
    }, { apply: parsed.apply });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "DISPOSITION_TOOL_FAILURE" }));
    process.exitCode = 1;
  });
}
