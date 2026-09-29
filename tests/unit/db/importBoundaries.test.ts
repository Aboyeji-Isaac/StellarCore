import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import { ESLint } from "eslint";

const ROOT = resolve(import.meta.dirname, "../../..");
const WRITER = "lib/db/writeClient.ts";
const READER = "lib/db/readClient.ts";
// Runtime imports only: `import type` / `export type` are erased at build time.
const SPECIFIER =
  /(?:^|[^\w.])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function sourceFiles(directory: string): string[] {
  const absolute = join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [toPosix(path)] : [];
  });
}

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(join(ROOT, from)), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(ROOT, candidate));
    }
  }
  return null;
}

/** Runtime module graph reachable from entry points, keyed by importer. */
function reachableModules(entries: readonly string[]): Map<string, string> {
  const parents = new Map<string, string>(entries.map((entry) => [entry, "<entry>"]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, match[1] ?? match[2]);
      if (target && !parents.has(target)) {
        parents.set(target, file);
        queue.push(target);
      }
    }
  }
  return parents;
}

function importChain(parents: Map<string, string>, file: string): string {
  const path = [file];
  let current = parents.get(file);
  while (current && current !== "<entry>") {
    path.unshift(current);
    current = parents.get(current);
  }
  return path.join(" -> ");
}

const PUBLIC_ENTRIES = Object.freeze([
  ...sourceFiles("app").filter((file) => !file.startsWith("app/api/internal/")),
  ...sourceFiles("components"),
  ...sourceFiles("hooks"),
]);

test("public routes, pages, and components never reach the database writer", () => {
  const reachable = reachableModules(PUBLIC_ENTRIES);
  assert.ok(reachable.has(READER), "public code should read through the read client");
  assert.equal(
    reachable.has(WRITER),
    false,
    reachable.has(WRITER) ? `writer reachable: ${importChain(reachable, WRITER)}` : undefined,
  );
});

test("the internal cron route reaches the writer through approved paths", () => {
  assert.ok(reachableModules(["app/api/internal/cron/refresh/route.ts"]).has(WRITER));
});

test("the lint boundary rejects public code that imports the writer", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const publicFile = join(ROOT, "lib/api/boundaryFixture.ts");
  const [staticImport] = await eslint.lintText(
    'import { writeDb } from "@/lib/db/writeClient";\nexport const leaked = writeDb;\n',
    { filePath: publicFile },
  );
  const [dynamicImport] = await eslint.lintText(
    'export async function leak() {\n  return import("../db/writeClient");\n}\n',
    { filePath: publicFile },
  );
  const [approved] = await eslint.lintText(
    'export async function write() {\n  return import("@/lib/db/writeClient");\n}\n',
    { filePath: join(ROOT, "lib/rates/snapshot.ts") },
  );

  for (const result of [staticImport, dynamicImport]) {
    assert.ok(result.messages.some(({ ruleId, message }) =>
      ruleId === "no-restricted-syntax" && message.includes("database writer")));
  }
  assert.equal(approved.messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"), false);
});
