import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_HASH_ALGORITHM,
  DEFAULT_MAX_DIFFERENCES,
  INSTALL_REPORT_SCHEMA_VERSION,
  NORMALIZATION_RULES,
  type ArtifactManifest,
  type BoundedDiff,
  type InstalledPackageRecord,
  type NormalizedDependencyGraph,
  type PlatformContext,
  type ToolchainContext,
  auditInstalledGraphAgainstLockfile,
  auditPhysicalScanAgainstHiddenLockfile,
  compareArtifactManifests,
  compareInstalledScans,
  compareNormalizedGraphs,
  compareToolchains,
  enginesNodeMajor,
  normalizeLockfileGraph,
  sha256,
} from "@/lib/tooling/installReproducibility";

const REPORT_DIR_DEFAULT = ".reports/install-reproducibility";
const PLACEHOLDER_DATABASE_URL =
  "postgresql://install-verify:install-verify@127.0.0.1:5432/install_verify";
const LIFECYCLE_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;
const LOG_TAIL_LINES = 40;
// The observable form of package.json / package-lock.json divergence is
// `npm ci` refusing to install.
const LOCKFILE_SYNC_ERROR_MARKER =
  "npm ci can only install packages when your package.json and package-lock.json";
const ARCHIVE_PATHS = ["package.json", "package-lock.json", "prisma.config.ts", "prisma"];

interface Options {
  ref: string;
  useWorktree: boolean;
  runs: number;
  reportDir: string;
  keepSandboxes: boolean;
  sharedCache?: string;
  maxDifferences: number;
}

interface InstallRunResult {
  id: string;
  sandboxPath: string;
  logPath: string;
  exitCode: number | null;
  signal: string | null;
  lockfileSyncError: boolean;
  toolchain: ToolchainContext;
  normalizedGraph: NormalizedDependencyGraph;
  installedScan: Record<string, InstalledPackageRecord>;
  artifactManifest: ArtifactManifest;
  lockfileMutatedByInstall: boolean;
  hiddenLockfileSha256: string;
  rootPostinstall: string | null;
}

interface CheckResult {
  check: string;
  passed: boolean;
  summary: string;
  diff?: unknown;
}

interface ReproducibilityReport {
  schemaVersion: typeof INSTALL_REPORT_SCHEMA_VERSION;
  issue: string;
  verdict: "reproducible" | "not-reproducible";
  reviewedRef: string;
  reviewedCommit: string | null;
  toolchain: ToolchainContext;
  packageEnginesNode: string | null;
  normalizationRules: readonly string[];
  runs: Array<{
    id: string;
    sandbox: string;
    exitCode: number | null;
    signal: string | null;
    lockfileSyncError: boolean;
    lockfileMutatedByInstall: boolean;
    hiddenLockfileSha256: string;
    installedPackageCount: number;
    generatedArtifactFileCount: number;
    rootPostinstall: string | null;
    logTail: string[];
  }>;
  checks: CheckResult[];
}

function fail(message: string): never {
  process.stderr.write(`verify:install-reproducibility: ${message}\n`);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    ref: "HEAD",
    useWorktree: false,
    runs: 2,
    reportDir: REPORT_DIR_DEFAULT,
    keepSandboxes: false,
    maxDifferences: DEFAULT_MAX_DIFFERENCES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) fail(`missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--ref") options.ref = value();
    else if (arg === "--worktree") options.useWorktree = true;
    else if (arg === "--runs") {
      const parsed = Number.parseInt(value(), 10);
      if (!Number.isInteger(parsed) || parsed < 2) fail("--runs must be an integer >= 2");
      options.runs = parsed;
    } else if (arg === "--report-dir") options.reportDir = value();
    else if (arg === "--keep-sandboxes") options.keepSandboxes = true;
    else if (arg === "--shared-cache") options.sharedCache = value();
    else if (arg === "--max-diff") {
      const parsed = Number.parseInt(value(), 10);
      if (!Number.isInteger(parsed) || parsed < 1) fail("--max-diff must be an integer >= 1");
      options.maxDifferences = parsed;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  return options;
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function detectLibc(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function platformContext(): PlatformContext {
  return { os: process.platform, cpu: process.arch, libc: detectLibc() };
}

function queryNpmVersion(env?: Record<string, string>): string {
  // Next.js augments ProcessEnv with a required NODE_ENV; the scrubbed sandbox
  // env intentionally has none.
  const result = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    ...(env ? { env: env as NodeJS.ProcessEnv } : {}),
  });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * Materialize the reviewed dependency inputs (package.json, lockfile, prisma
 * files) from the git ref so verification never depends on developer
 * working-tree state. The returned staging directory is copied into every
 * sandbox.
 */
function stageReviewedInputs(options: Options): { stageDir: string; commit: string | null } {
  const stageDir = mkdtempSync(join(tmpdir(), "stellarcore-install-verify-stage-"));
  if (options.useWorktree) {
    for (const path of ARCHIVE_PATHS) {
      if (!existsSync(path)) fail(`--worktree requires ${path} in the working tree`);
    }
    cpSync("package.json", join(stageDir, "package.json"));
    cpSync("package-lock.json", join(stageDir, "package-lock.json"));
    cpSync("prisma.config.ts", join(stageDir, "prisma.config.ts"));
    cpSync("prisma", join(stageDir, "prisma"), { recursive: true });
    return { stageDir, commit: null };
  }
  const dirty = runGit(["status", "--porcelain", "--", "package.json", "package-lock.json"]);
  if (dirty.length > 0) {
    fail(
      [
        "package.json / package-lock.json differ between the working tree and the reviewed ref.",
        `Verification installs from a single reviewed ref (${options.ref}).`,
        "Commit or stash the dependency changes, or pass --worktree to verify the working tree instead.",
      ].join(" "),
    );
  }
  const commit = runGit(["rev-parse", options.ref]);
  const archive = spawnSync("git", ["archive", "--format=tar", options.ref, ...ARCHIVE_PATHS], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    fail(`git archive ${options.ref} failed: ${(archive.stderr ?? "").toString().trim()}`);
  }
  const tarPath = `${stageDir}.tar`;
  writeFileSync(tarPath, archive.stdout);
  const extract = spawnSync("tar", ["-xf", tarPath, "-C", stageDir]);
  rmSync(tarPath, { force: true });
  if (extract.status !== 0) {
    fail(`tar extraction failed: ${(extract.stderr ?? "").toString().trim()}`);
  }
  return { stageDir, commit };
}

function scrubEnvironment(sharedCache?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Drop inherited npm/node configuration so resolution depends only on the
    // sandbox's own config files, never the developer's shell state.
    if (value === undefined || /^(npm_|init_cwd|node_options|node_env)/i.test(key)) continue;
    env[key] = value;
  }
  env.npm_config_cache = sharedCache ?? "__SANDBOX__/npm-cache";
  env.NPM_CONFIG_USERCONFIG = "__SANDBOX__/npmrc";
  env.NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  env.CI = "1";
  env.DATABASE_URL = PLACEHOLDER_DATABASE_URL;
  env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  return env;
}

function collectInstalledScan(nodeModulesRoot: string): Record<string, InstalledPackageRecord> {
  const records: Record<string, InstalledPackageRecord> = {};
  const readRecord = (packageDir: string): InstalledPackageRecord | null => {
    try {
      const raw = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
        scripts?: Record<string, unknown>;
      };
      if (typeof raw.name !== "string" || typeof raw.version !== "string") return null;
      const scripts = raw.scripts ?? {};
      return {
        name: raw.name,
        version: raw.version,
        hasInstallScript: LIFECYCLE_SCRIPT_NAMES.some(
          (script) => typeof scripts[script] === "string",
        ),
      };
    } catch {
      return null;
    }
  };
  const visitPackageDir = (packageDir: string, relativePath: string): void => {
    // A package's own internal package.json files (examples, fixtures) are not
    // install locations, so only package dirs and their nested node_modules
    // are walked.
    const record = readRecord(packageDir);
    if (record) {
      records[`node_modules/${relativePath}`] = record;
    }
    const nested = join(packageDir, "node_modules");
    if (existsSync(nested)) {
      visitNodeModulesDir(nested, `${relativePath}/node_modules`);
    }
  };
  const visitNodeModulesDir = (dir: string, relativePrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const childPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith("@")) {
        visitNodeModulesDir(join(dir, entry.name), childPath);
      } else {
        visitPackageDir(join(dir, entry.name), childPath);
      }
    }
  };
  visitNodeModulesDir(nodeModulesRoot, "");
  return records;
}

function normalizeSandboxPath(content: string, sandboxPath: string): string {
  let sandboxRealPath = sandboxPath;
  try {
    sandboxRealPath = realpathSync(sandboxPath);
  } catch {
    // Fall back to the literal path when the sandbox is already gone.
  }
  return content.split(sandboxRealPath).join("<sandbox>").split(sandboxPath).join("<sandbox>");
}

function buildArtifactManifest(artifactRoot: string, sandboxPath: string): ArtifactManifest {
  const files: Record<string, string> = {};
  const visit = (dir: string, relativePrefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files[relativePath] = sha256(normalizeSandboxPath(readFileSync(fullPath, "utf8"), sandboxPath));
    }
  };
  if (existsSync(artifactRoot)) {
    visit(artifactRoot, "");
  }
  return {
    algorithm: ARTIFACT_HASH_ALGORITHM,
    root: relative(process.cwd(), artifactRoot) || artifactRoot,
    fileCount: Object.keys(files).length,
    files,
  };
}

function normalizedLogTail(logPath: string, sandboxPath: string): string[] {
  let content = "";
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((line) => normalizeSandboxPath(line, sandboxPath))
    .filter((line) => line.trim().length > 0)
    .slice(-LOG_TAIL_LINES);
}

function runIsolatedInstall(
  runIndex: number,
  stageDir: string,
  options: Options,
): InstallRunResult {
  const id = `run-${runIndex + 1}`;
  const sandboxPath = mkdtempSync(join(tmpdir(), `stellarcore-install-verify-${id}-`));
  const env = scrubEnvironment(options.sharedCache);
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      env[key] = value.split("__SANDBOX__").join(sandboxPath);
    }
  }
  for (const path of ARCHIVE_PATHS) {
    cpSync(join(stageDir, path), join(sandboxPath, path), { recursive: true });
  }
  writeFileSync(join(sandboxPath, "npmrc"), "");
  const logPath = join(sandboxPath, "install.log");
  const logFd = openSync(logPath, "w");
  const npm = spawnSync(
    "npm",
    ["ci", "--no-audit", "--no-fund", "--foreground-scripts", "--loglevel=info"],
    { cwd: sandboxPath, env: env as NodeJS.ProcessEnv, stdio: ["ignore", logFd, logFd] },
  );
  closeSync(logFd);

  const result: InstallRunResult = {
    id,
    sandboxPath,
    logPath,
    exitCode: npm.status,
    signal: npm.signal ?? null,
    lockfileSyncError: false,
    toolchain: {
      nodeVersion: process.version,
      npmVersion: queryNpmVersion(env),
      platform: process.platform,
      arch: process.arch,
      libc: detectLibc(),
      reviewedRef: options.useWorktree ? "worktree" : options.ref,
      packageJsonSha256: sha256(readFileSync(join(stageDir, "package.json"))),
      packageLockSha256: sha256(readFileSync(join(stageDir, "package-lock.json"))),
    },
    normalizedGraph: { lockfileVersion: null, root: null, packages: {} },
    installedScan: {},
    artifactManifest: {
      algorithm: ARTIFACT_HASH_ALGORITHM,
      root: "app/generated/prisma",
      fileCount: 0,
      files: {},
    },
    lockfileMutatedByInstall: false,
    hiddenLockfileSha256: "",
    rootPostinstall: null,
  };

  if (npm.status === 0) {
    const hiddenLockfile = readFileSync(
      join(sandboxPath, "node_modules", ".package-lock.json"),
      "utf8",
    );
    result.hiddenLockfileSha256 = sha256(hiddenLockfile);
    result.normalizedGraph = normalizeLockfileGraph(JSON.parse(hiddenLockfile));
    result.installedScan = collectInstalledScan(join(sandboxPath, "node_modules"));
    result.artifactManifest = buildArtifactManifest(
      join(sandboxPath, "app", "generated", "prisma"),
      sandboxPath,
    );
    result.lockfileMutatedByInstall =
      sha256(readFileSync(join(stageDir, "package-lock.json"))) !==
      sha256(readFileSync(join(sandboxPath, "package-lock.json")));
    const rootPackageJson = JSON.parse(
      readFileSync(join(sandboxPath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    const postinstall = rootPackageJson.scripts?.postinstall;
    result.rootPostinstall = typeof postinstall === "string" ? postinstall : null;
  } else {
    const logContent = readFileSync(logPath, "utf8");
    result.lockfileSyncError = logContent.includes(LOCKFILE_SYNC_ERROR_MARKER);
  }
  return result;
}

function checkFromDiff<T>(
  check: string,
  passSummary: string,
  failSummary: string,
  diff: BoundedDiff<T>,
): CheckResult {
  const passed = diff.total === 0;
  return {
    check,
    passed,
    summary: passed ? passSummary : `${failSummary} (${diff.total} difference(s)${diff.truncated ? ", truncated" : ""})`,
    ...(passed ? {} : { diff }),
  };
}

function buildChecks(
  runs: InstallRunResult[],
  reviewedGraph: NormalizedDependencyGraph,
  enginesNode: string | null,
  options: Options,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const failedRuns = runs.filter((run) => run.exitCode !== 0);
  checks.push({
    check: "isolated-installs-succeed",
    passed: failedRuns.length === 0,
    summary:
      failedRuns.length === 0
        ? `all ${runs.length} isolated installs exited 0`
        : `${failedRuns.length}/${runs.length} install(s) failed` +
          (failedRuns.some((run) => run.lockfileSyncError)
            ? "; npm ci reported package.json/package-lock.json divergence (lockfile mismatch fails verification)"
            : ""),
    ...(failedRuns.length > 0
      ? {
          diff: failedRuns.map((run) => ({
            run: run.id,
            exitCode: run.exitCode,
            signal: run.signal,
            lockfileSyncError: run.lockfileSyncError,
          })),
        }
      : {}),
  });
  if (failedRuns.length > 0) {
    return checks;
  }

  const [first, ...rest] = runs;
  for (const run of rest) {
    checks.push(
      checkFromDiff(
        `${first.id}-vs-${run.id}:normalized-dependency-graph`,
        "installed dependency graphs (hidden lockfiles) are identical across isolated installs",
        "installed dependency graphs diverge between isolated installs",
        compareNormalizedGraphs(first.normalizedGraph, run.normalizedGraph, options.maxDifferences),
      ),
      checkFromDiff(
        `${first.id}-vs-${run.id}:node-modules-layout`,
        "physical node_modules package layout is identical across isolated installs",
        "physical node_modules layout diverges between isolated installs",
        compareInstalledScans(first.installedScan, run.installedScan, options.maxDifferences),
      ),
      checkFromDiff(
        `${first.id}-vs-${run.id}:generated-artifacts`,
        "generated artifacts (app/generated/prisma) are identical after sandbox-path normalization",
        "generated artifacts diverge between isolated installs",
        compareArtifactManifests(first.artifactManifest, run.artifactManifest, options.maxDifferences),
      ),
      checkFromDiff(
        `${first.id}-vs-${run.id}:toolchain`,
        "toolchain versions are identical across runs and recorded in the report",
        "toolchain differs between runs",
        {
          total: compareToolchains(first.toolchain, run.toolchain).length,
          shown: compareToolchains(first.toolchain, run.toolchain),
          truncated: false,
          maxShown: options.maxDifferences,
        },
      ),
    );
  }

  const platform = platformContext();
  const audit = auditInstalledGraphAgainstLockfile(
    reviewedGraph,
    first.normalizedGraph,
    platform,
    options.maxDifferences,
  );
  checks.push(
    checkFromDiff(
      "installed-graph-matches-reviewed-lockfile",
      "every installed package matches the reviewed lockfile (name, version, integrity, resolved, edges, lifecycle marker, optional/peer flags)",
      "installed resolution diverges from the reviewed lockfile (lockfile metadata drift or unexpected transitive resolution change)",
      audit.issues,
    ),
    {
      check: "install-scope-flag-drift-noted",
      passed: true,
      summary:
        audit.scopeFlagDrift.total === 0
          ? "no dev/devOptional scope-flag drift against the reviewed lockfile"
          : `${audit.scopeFlagDrift.total} dev/devOptional scope-flag difference(s) recorded (npm bookkeeping; non-fatal, see report)`,
      ...(audit.scopeFlagDrift.total > 0 ? { diff: audit.scopeFlagDrift } : {}),
    },
    checkFromDiff(
      "disk-layout-matches-hidden-lockfile",
      "physical node_modules matches the installed hidden lockfile",
      "physical node_modules does not match the hidden lockfile",
      auditPhysicalScanAgainstHiddenLockfile(
        first.installedScan,
        first.normalizedGraph,
        options.maxDifferences,
      ),
    ),
  );

  const mutated = runs.filter((run) => run.lockfileMutatedByInstall);
  checks.push({
    check: "lockfile-not-mutated-by-install",
    passed: mutated.length === 0,
    summary:
      mutated.length === 0
        ? "npm ci left the reviewed lockfile byte-identical in every sandbox"
        : `npm ci rewrote package-lock.json in ${mutated.map((run) => run.id).join(", ")}`,
  });

  const toolchain = first.toolchain;
  const recorded = toolchain.nodeVersion.length > 0 && toolchain.npmVersion.length > 0;
  checks.push({
    check: "toolchain-recorded",
    passed: recorded,
    summary: recorded
      ? `node ${toolchain.nodeVersion} / npm ${toolchain.npmVersion} on ${toolchain.platform}-${toolchain.arch}${toolchain.libc ? ` (libc ${toolchain.libc})` : ""} recorded with ref ${toolchain.reviewedRef} and lockfile digest ${toolchain.packageLockSha256.slice(0, 12)}`
      : "could not determine node/npm versions",
  });
  const expectedMajor = enginesNodeMajor(enginesNode);
  const actualMajor = Number.parseInt(toolchain.nodeVersion.replace(/^v/, ""), 10);
  const enginesSatisfied = expectedMajor === null || expectedMajor === actualMajor;
  checks.push({
    check: "toolchain-engines-note",
    // Warning, not fatal: npm ci does not enforce engines and release CI pins
    // the reviewed toolchain; drift is still surfaced in the report.
    passed: true,
    summary: enginesSatisfied
      ? `node ${toolchain.nodeVersion} satisfies package.json engines.node "${enginesNode}"`
      : `WARNING: node ${toolchain.nodeVersion} does not satisfy package.json engines.node "${enginesNode}"; install verification ran on an off-spec toolchain`,
  });
  return checks;
}

function renderSummary(report: ReproducibilityReport): string {
  const lines: string[] = [];
  lines.push(`Dependency-install reproducibility: ${report.verdict.toUpperCase()} (issue ${report.issue})`);
  lines.push(
    `Reviewed ref: ${report.reviewedRef}${report.reviewedCommit ? ` (${report.reviewedCommit})` : ""}`,
  );
  lines.push(
    `Toolchain: node ${report.toolchain.nodeVersion}, npm ${report.toolchain.npmVersion}, ${report.toolchain.platform}-${report.toolchain.arch}${report.toolchain.libc ? `, libc ${report.toolchain.libc}` : ""}`,
  );
  for (const run of report.runs) {
    lines.push(
      `${run.id}: exit ${run.exitCode ?? `signal ${run.signal}`}, ${run.installedPackageCount} installed packages, ${run.generatedArtifactFileCount} generated files`,
    );
  }
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.passed ? "PASS" : "FAIL"}] ${check.check} — ${check.summary}`);
  }
  return lines.join("\n") + "\n";
}

function writeReport(
  reportDir: string,
  report: ReproducibilityReport,
  runs: InstallRunResult[],
): void {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(reportDir, "summary.txt"), renderSummary(report));
  for (const run of runs) {
    const runDir = join(reportDir, run.id);
    mkdirSync(runDir, { recursive: true });
    if (existsSync(run.logPath)) {
      cpSync(run.logPath, join(runDir, "install.log"));
    }
    writeFileSync(
      join(runDir, "manifests.json"),
      JSON.stringify(
        {
          toolchain: run.toolchain,
          normalizedHiddenLockfileGraph: run.normalizedGraph,
          installedScan: run.installedScan,
          generatedArtifactManifest: run.artifactManifest,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

function main(): void {
  const entrypoint = process.argv[1];
  if (!entrypoint || import.meta.url !== pathToFileURL(entrypoint).href) {
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const { stageDir, commit } = stageReviewedInputs(options);
  const sandboxes: string[] = [];
  const runs: InstallRunResult[] = [];
  try {
    for (let index = 0; index < options.runs; index += 1) {
      const run = runIsolatedInstall(index, stageDir, options);
      runs.push(run);
      sandboxes.push(run.sandboxPath);
    }
    const reviewedGraph = normalizeLockfileGraph(
      JSON.parse(readFileSync(join(stageDir, "package-lock.json"), "utf8")),
    );
    const rootPackageJson = JSON.parse(
      readFileSync(join(stageDir, "package.json"), "utf8"),
    ) as { engines?: { node?: unknown } };
    const enginesNode =
      typeof rootPackageJson.engines?.node === "string" ? rootPackageJson.engines.node : null;

    const report: ReproducibilityReport = {
      schemaVersion: INSTALL_REPORT_SCHEMA_VERSION,
      issue: "#237",
      verdict: "not-reproducible",
      reviewedRef: options.useWorktree ? "worktree" : options.ref,
      reviewedCommit: commit,
      toolchain: runs[0]?.toolchain ?? {
        nodeVersion: process.version,
        npmVersion: queryNpmVersion(),
        platform: process.platform,
        arch: process.arch,
        libc: detectLibc(),
        reviewedRef: options.useWorktree ? "worktree" : options.ref,
        packageJsonSha256: "",
        packageLockSha256: "",
      },
      packageEnginesNode: enginesNode,
      normalizationRules: NORMALIZATION_RULES,
      runs: runs.map((run) => ({
        id: run.id,
        sandbox: "<sandbox>",
        exitCode: run.exitCode,
        signal: run.signal,
        lockfileSyncError: run.lockfileSyncError,
        lockfileMutatedByInstall: run.lockfileMutatedByInstall,
        hiddenLockfileSha256: run.hiddenLockfileSha256,
        installedPackageCount: Object.keys(run.installedScan).length,
        generatedArtifactFileCount: run.artifactManifest.fileCount,
        rootPostinstall: run.rootPostinstall,
        logTail: normalizedLogTail(run.logPath, run.sandboxPath),
      })),
      checks: buildChecks(runs, reviewedGraph, enginesNode, options),
    };
    report.verdict = report.checks.every((check) => check.passed)
      ? "reproducible"
      : "not-reproducible";
    writeReport(options.reportDir, report, runs);
    process.stdout.write(renderSummary(report));
    process.stdout.write(`Full report and logs: ${options.reportDir}\n`);
    if (report.verdict !== "reproducible") {
      process.exitCode = 1;
    }
  } finally {
    if (!options.keepSandboxes) {
      for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
    }
    rmSync(stageDir, { recursive: true, force: true });
  }
}

main();
