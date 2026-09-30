import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  listSep1Observations,
  reviewSep1Observation,
  Sep1ReviewError,
  type Sep1HistoryDb,
} from "@/lib/stellar/sep1HistoryRepository";

const USAGE = [
  "Usage:",
  "  npm run review:sep1 -- list <anchor-slug>",
  "  npm run review:sep1 -- approve <anchor-slug> <observation-digest> --actor <id> --reference <ref> --reason <text>",
  "  npm run review:sep1 -- reject  <anchor-slug> <observation-digest> --actor <id> --reference <ref> --reason <text>",
].join("\n");

export type ReviewCliResult = Readonly<{ exitCode: number; output: string }>;

export function parseFlags(args: readonly string[]): {
  positionals: string[];
  flags: Record<string, string>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags[arg.slice(2)] = "";
      } else {
        flags[arg.slice(2)] = value;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/**
 * Operator-only workflow: reads/writes the database directly with the
 * operator's DATABASE_URL. There is deliberately no HTTP mutation endpoint.
 */
export async function runReviewCli(
  args: readonly string[],
  db: Sep1HistoryDb & Parameters<typeof reviewSep1Observation>[0],
): Promise<ReviewCliResult> {
  const { positionals, flags } = parseFlags(args);
  const [command, anchorSlug, digest] = positionals;

  try {
    if (command === "list" && anchorSlug) {
      const { baseline, observations, reviews } = await listSep1Observations(db, anchorSlug);
      return ok({
        anchor: anchorSlug,
        // UNAVAILABLE = no review has ever approved metadata for this anchor
        // (legacy anchors are never back-filled). Not an anchor status.
        approvedBaseline: baseline.state === "APPROVED"
          ? {
              state: "APPROVED",
              observationDigest: baseline.observationDigest,
              reviewedAt: baseline.reviewedAt.toISOString(),
            }
          : { state: "UNAVAILABLE" },
        observations: observations.map((o) => ({
          digest: o.digest,
          assessment: o.assessment,
          changedFields: (o.diff as { field: string }[]).map(({ field }) => field),
          fetchedAt: o.fetchedAt.toISOString(),
        })),
        reviews: reviews.map((r) => ({
          observationDigest: r.observationDigest,
          decision: r.decision,
          actor: r.actor,
          reference: r.reference,
          reviewedFields: r.reviewedFields,
          reviewedAt: r.reviewedAt.toISOString(),
        })),
      });
    }

    if ((command === "approve" || command === "reject") && anchorSlug && digest) {
      const review = await reviewSep1Observation(db, {
        anchorSlug,
        observationDigest: digest,
        decision: command === "approve" ? "APPROVED" : "REJECTED",
        actor: flags.actor ?? "",
        reference: flags.reference ?? "",
        reason: flags.reason ?? "",
      });
      return ok({
        recorded: review.decision,
        anchor: anchorSlug,
        observationDigest: review.observationDigest,
        reviewedFields: review.reviewedFields,
        note: "Review records that this observed metadata was reviewed; it does not prove anchor reachability or quote correctness.",
      });
    }
  } catch (error) {
    if (error instanceof Sep1ReviewError) {
      return { exitCode: 1, output: JSON.stringify({ ok: false, code: error.code }) };
    }
    throw error;
  }

  return { exitCode: 2, output: USAGE };
}

function ok(body: unknown): ReviewCliResult {
  return { exitCode: 0, output: JSON.stringify(body, null, 2) };
}

async function main(): Promise<void> {
  const { db } = await import("@/lib/dbClient");
  try {
    const result = await runReviewCli(process.argv.slice(2), db);
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.exitCode;
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "SEP1_REVIEW_FAILURE" }));
    process.exitCode = 1;
  });
}
