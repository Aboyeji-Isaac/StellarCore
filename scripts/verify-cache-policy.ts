import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CACHE_CLASS_DIRECTIVES,
  EVIDENCE_VARY_VALUE,
} from "@/constants/apiCachePolicy";

/**
 * Production cache-policy verification.
 *
 * Runs `next start` against the existing production build and asserts the
 * intermediary-cache headers every public route, page, and static resource
 * actually receives over HTTP — including 4xx/5xx error responses, which must
 * carry the same policy as successes so a cached failure cannot mask recovery.
 * Handler-level unit tests cannot see framework defaults, `next.config.ts`
 * header injection, or static-asset behavior; this script covers exactly that
 * surface. It performs no database writes and needs no database: database-
 * backed checks accept the success or failure statuses a DB-less server
 * produces and pin the headers either way.
 *
 * Requires `npm run build` first. Used by `.github/workflows/cache-policy.yml`.
 */

const PORT = Number(process.env.CACHE_POLICY_PORT ?? 4318);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const EVIDENCE_CC = CACHE_CLASS_DIRECTIVES.evidence_api;
const EVIDENCE_PAGE_CC = CACHE_CLASS_DIRECTIVES.evidence_page;
const INTERNAL_CC = CACHE_CLASS_DIRECTIVES.internal_api;
const STATIC_PAGE_CC = CACHE_CLASS_DIRECTIVES.static_page;
const NOT_FOUND_CC = CACHE_CLASS_DIRECTIVES.framework_not_found;
const HASHED_CC = CACHE_CLASS_DIRECTIVES.hashed_build_asset;
const PUBLIC_ASSET_CC = CACHE_CLASS_DIRECTIVES.public_asset;

type Check = Readonly<{
  name: string;
  path: string;
  allowedStatuses: readonly number[];
  cacheControl: string;
  /** When true, `Vary` must include the evidence value. */
  vary: boolean;
}>;

function evidence(path: string, allowedStatuses: readonly number[]): Check {
  return { name: "evidence api", path, allowedStatuses, cacheControl: EVIDENCE_CC, vary: true };
}

const CHECKS: readonly Check[] = [
  evidence("/api/anchors", [200, 500]),
  evidence("/api/anchors/BAD__SLUG", [400]),
  evidence("/api/anchors/zeam", [200, 404, 500]),
  evidence("/api/corridors", [200, 500]),
  evidence("/api/corridors/BAD__SLUG", [400]),
  evidence("/api/corridors/usdc-us-brl-br", [200, 404, 500]),
  evidence("/api/rates", [400]),
  evidence("/api/rates?corridor=bad--slug", [400]),
  evidence("/api/rates?corridor=usdc-us-brl-br", [200, 404, 500]),
  evidence("/api/reputation", [200, 500]),
  evidence("/api/reputation/BAD__SLUG", [400]),
  evidence("/api/reputation/zeam", [200, 404, 500]),
  {
    name: "internal api",
    path: "/api/internal/cron/refresh",
    allowedStatuses: [401],
    cacheControl: INTERNAL_CC,
    vary: true,
  },
  {
    name: "framework api 404",
    path: "/api/not-a-real-route",
    allowedStatuses: [404],
    cacheControl: NOT_FOUND_CC,
    vary: true,
  },
  {
    name: "evidence page",
    path: "/dashboard",
    allowedStatuses: [200],
    cacheControl: EVIDENCE_PAGE_CC,
    vary: true,
  },
  {
    name: "evidence page",
    path: "/corridors/usdc-us-brl-br",
    allowedStatuses: [200, 404],
    cacheControl: EVIDENCE_PAGE_CC,
    vary: true,
  },
  {
    name: "static landing page",
    path: "/",
    allowedStatuses: [200],
    cacheControl: STATIC_PAGE_CC,
    vary: false,
  },
  {
    name: "framework page 404",
    path: "/no-such-page",
    allowedStatuses: [404],
    cacheControl: NOT_FOUND_CC,
    vary: true,
  },
  {
    name: "hashed build asset",
    path: findHashedAsset(),
    allowedStatuses: [200],
    cacheControl: HASHED_CC,
    vary: false,
  },
  {
    name: "public asset",
    path: "/StellarCore.png",
    allowedStatuses: [200],
    cacheControl: PUBLIC_ASSET_CC,
    vary: false,
  },
];

function findHashedAsset(): string {
  const chunksDirectory = join(process.cwd(), ".next", "static", "chunks");
  if (!existsSync(chunksDirectory)) {
    throw new Error(`Missing ${chunksDirectory}; run \`npm run build\` first.`);
  }
  const stack = [chunksDirectory];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name.endsWith(".js")) {
        return `/_next/static/${fullPath.slice(join(process.cwd(), ".next", "static").length + 1)}`.replaceAll("\\", "/");
      }
    }
  }
  throw new Error("No hashed build asset found; run `npm run build` first.");
}

type CheckResult = Readonly<{
  check: Check;
  ok: boolean;
  messages: readonly string[];
}>;

async function runCheck(check: Check): Promise<CheckResult> {
  const messages: string[] = [];
  let status = 0;
  let cacheControl: string | null = null;
  let vary: string | null = null;

  try {
    const response = await fetch(`${ORIGIN}${check.path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    cacheControl = response.headers.get("cache-control");
    vary = response.headers.get("vary");
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    messages.push(`request failed: ${String(error)}`);
  }

  if (!check.allowedStatuses.includes(status)) {
    messages.push(
      `status ${status} not in allowed set [${check.allowedStatuses.join(", ")}]`,
    );
  }
  if (cacheControl !== check.cacheControl) {
    messages.push(
      `Cache-Control ${JSON.stringify(cacheControl)} !== ${JSON.stringify(check.cacheControl)}`,
    );
  }
  if (check.vary && !(vary ?? "").toLowerCase().includes(EVIDENCE_VARY_VALUE.toLowerCase())) {
    messages.push(`Vary ${JSON.stringify(vary)} does not include ${EVIDENCE_VARY_VALUE}`);
  }

  return { check, ok: messages.length === 0, messages };
}

function startServer(): ChildProcess {
  const nextBin = join("node_modules", "next", "dist", "bin", "next");
  const child = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(PORT)],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return child;
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("next start exited before becoming ready; run `npm run build` first.");
    }
    try {
      const response = await fetch(`${ORIGIN}/api/rates`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status > 0) return;
    } catch {
      // Server not ready yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`next start was not ready within ${START_TIMEOUT_MS}ms on port ${PORT}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    throw new Error("No production build found; run `npm run build` before `npm run verify:cache`.");
  }

  const child = startServer();
  let results: CheckResult[] = [];
  let startupError: unknown = null;

  try {
    await waitForServer(child);
    results = await Promise.all(CHECKS.map(runCheck));
  } catch (error) {
    startupError = error;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }

  if (startupError !== null) throw startupError;

  let failures = 0;
  for (const result of results) {
    if (result.ok) {
      process.stdout.write(
        `ok   ${result.check.name.padEnd(22)} ${result.check.path}\n`,
      );
    } else {
      failures += 1;
      process.stdout.write(
        `FAIL ${result.check.name.padEnd(22)} ${result.check.path}\n`
          + result.messages.map((message) => `     - ${message}\n`).join(""),
      );
    }
  }

  process.stdout.write(
    `\n${results.length - failures}/${results.length} cache policy checks passed\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`verify:cache failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
