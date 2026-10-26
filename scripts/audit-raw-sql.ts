import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOTS = ["app", "lib", "scripts"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const REVIEWED_RAW_SQL_FILES = new Set([
  "lib/config/environmentGuardDb.ts",
  "lib/health/http.ts",
  "lib/rates/latestRateRepository.ts",
  "lib/rates/rateHistoryRepository.ts",
  "lib/reputation/repository.ts",
  "lib/reputation/snapshot.ts",
  "lib/stellar/anchorSync.ts",
  "scripts/stamp-database-environment.ts",
]);

type Finding = Readonly<{
  file: string;
  code:
    | "UNREVIEWED_RAW_SQL_BOUNDARY"
    | "UNSAFE_RAW_API"
    | "PRISMA_RAW_FRAGMENT"
    | "UNREVIEWED_SQL_TEMPLATE_HELPER";
  detail: string;
}>;

async function main(): Promise<void> {
  const files = (
    await Promise.all(ROOTS.map((root) => collectSourceFiles(root)))
  ).flat().sort();

  const findings: Finding[] = [];
  const inventory: Array<Readonly<{
    file: string;
    queryRaw: number;
    executeRaw: number;
    queryRawUnsafe: number;
    executeRawUnsafe: number;
    prismaSql: number;
    prismaRaw: number;
    prismaJoin: number;
  }>> = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const normalized = file.replaceAll("\\", "/");
    if (normalized === "scripts/audit-raw-sql.ts") continue;

    const counts = {
      queryRaw: count(source, /\$queryRaw(?!Unsafe)\b/g),
      executeRaw: count(source, /\$executeRaw(?!Unsafe)\b/g),
      queryRawUnsafe: count(source, /\$queryRawUnsafe\b/g),
      executeRawUnsafe: count(source, /\$executeRawUnsafe\b/g),
      prismaSql: count(source, /\bPrisma\.sql\b/g),
      prismaRaw: count(source, /\bPrisma\.raw\b/g),
      prismaJoin: count(source, /\bPrisma\.join\b/g),
    };

    const hasRawBoundary =
      counts.queryRaw +
        counts.executeRaw +
        counts.queryRawUnsafe +
        counts.executeRawUnsafe >
      0;

    if (hasRawBoundary || counts.prismaSql || counts.prismaRaw || counts.prismaJoin) {
      inventory.push(Object.freeze({ file: normalized, ...counts }));
    }

    if (hasRawBoundary && !REVIEWED_RAW_SQL_FILES.has(normalized)) {
      findings.push(Object.freeze({
        file: normalized,
        code: "UNREVIEWED_RAW_SQL_BOUNDARY",
        detail:
          "Raw Prisma SQL usage is only allowed in the reviewed boundary list. Add a reviewed allowlist entry with tests and documentation.",
      }));
    }

    if (counts.prismaRaw > 0) {
      findings.push(Object.freeze({
        file: normalized,
        code: "PRISMA_RAW_FRAGMENT",
        detail:
          "Prisma.raw is prohibited because it can inject identifier or SQL text. Use constant SQL or a reviewed explicit identifier allowlist.",
      }));
    }

    if (
      (counts.prismaSql > 0 || counts.prismaJoin > 0) &&
      !REVIEWED_RAW_SQL_FILES.has(normalized)
    ) {
      findings.push(Object.freeze({
        file: normalized,
        code: "UNREVIEWED_SQL_TEMPLATE_HELPER",
        detail:
          "Prisma SQL-template helpers outside reviewed raw-SQL boundary files require explicit review.",
      }));
    }

    if (counts.queryRawUnsafe > 0 || counts.executeRawUnsafe > 0) {
      findings.push(Object.freeze({
        file: normalized,
        code: "UNSAFE_RAW_API",
        detail: "Unsafe Prisma raw APIs are prohibited. Use a parameterized SQL template.",
      }));
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: findings.length === 0,
      reviewedBoundaryCount: inventory.length,
      inventory,
      findings,
    })}\n`,
  );

  if (findings.length > 0) process.exitCode = 1;
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated") continue;
        await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(relative(process.cwd(), path));
      }
    }
  };
  await visit(root);
  return files;
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

void main();
