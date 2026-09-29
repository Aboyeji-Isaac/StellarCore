/**
 * Offline dependency-advisory policy evaluator (issue #147).
 *
 * Pure and network-free: it takes an already-retrieved `npm audit --json`
 * report (auditReportVersion 2), the parsed package-lock.json, the reviewed
 * exceptions file and a clock, and returns an explicit status. Retrieval of
 * current advisory data belongs to the dedicated security job, never here.
 *
 * A "pass" means: no policy-blocking findings in the scanned lockfile scope,
 * according to the advisory data the scanner had at run time. It is not proof
 * that the software has no vulnerabilities.
 */

export type Severity = "info" | "low" | "moderate" | "high" | "critical";
export type Scope = "production" | "development";
export type PolicyStatus =
  | "pass"
  | "policy-violation"
  | "expired-exception"
  | "malformed-output"
  | "invalid-exceptions"
  | "scanner-failure";
export type Disposition =
  | "blocking"
  | "excepted"
  | "expired-exception"
  | "below-threshold";

export interface LockfilePackage {
  version?: string;
  /** npm sets `dev: true` only for packages reachable exclusively via devDependencies. */
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
}
export interface Lockfile {
  packages: Record<string, LockfilePackage>;
}

export interface AdvisoryException {
  advisoryId: string;
  package: string;
  versionRange: string;
  scope: Scope;
  rationale: string;
  owner: string;
  expires: string; // YYYY-MM-DD, inclusive, UTC
}

export interface Finding {
  advisoryId: string;
  package: string;
  version: string;
  nodePath: string;
  scope: Scope;
  severity: Severity;
  title: string;
  disposition: Disposition;
}

export interface PolicyOptions {
  /** Findings below this severity are reported but do not block. Default: "low" (everything blocks). */
  minBlockingSeverity?: Severity;
  /** Exceptions expiring further out than this many days from `now` are rejected. Default: 180. */
  maxExceptionDays?: number;
}

export interface PolicyResult {
  status: PolicyStatus;
  findings: Finding[];
  unusedExceptions: AdvisoryException[];
  errors: string[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const MAX_ERRORS = 20;
const DAY_MS = 86_400_000;
const GHSA_RE = /GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const EXCEPTION_KEYS = [
  "advisoryId",
  "package",
  "versionRange",
  "scope",
  "rationale",
  "owner",
  "expires",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && Object.hasOwn(SEVERITY_RANK, v);
}
/** Keep only characters that cannot carry URLs, credentials or markdown. */
function sanitize(v: string, max = 80): string {
  return v.replace(/[^A-Za-z0-9 _.@/:()-]/g, "").slice(0, max);
}

// ---------------------------------------------------------------------------
// Version ranges: AND-only comparators, must have an upper bound.
// ---------------------------------------------------------------------------

type Triple = [number, number, number];
interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  v: Triple;
}

function parseTriple(s: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/** Returns null when the range is unparseable or has no upper bound (too broad). */
export function parseRange(range: string): Comparator[] | null {
  const tokens = range.trim().split(/\s+/);
  if (tokens.length < 1 || tokens.length > 4) return null;
  const out: Comparator[] = [];
  for (const t of tokens) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(t);
    if (!m) return null;
    const v = parseTriple(m[2]);
    if (!v) return null;
    out.push({ op: (m[1] ?? "=") as Comparator["op"], v });
  }
  const bounded = out.some((c) => c.op === "<" || c.op === "<=" || c.op === "=");
  return bounded ? out : null;
}
/** Prerelease/build versions never match an exception (conservative). */
export function versionInRange(version: string, range: string): boolean {
  const v = parseTriple(version);
  const cmps = parseRange(range);
  if (!v || !cmps) return false;
  return cmps.every(({ op, v: b }) => {
    const c = compare(v, b);
    return op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
  });
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

function expiryMs(expires: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null;
  const t = Date.parse(`${expires}T23:59:59.999Z`);
  if (Number.isNaN(t)) return null;
  // Reject calendar overflow such as 2026-02-31.
  return new Date(t).toISOString().slice(0, 10) === expires ? t : null;
}

export function validateExceptions(
  raw: unknown,
  now: Date,
  maxDays: number,
): { exceptions: AdvisoryException[]; errors: string[] } {
  const errors: string[] = [];
  const exceptions: AdvisoryException[] = [];
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.exceptions)) {
    return { exceptions, errors: ['exceptions file must be {"version":1,"exceptions":[...]}'] };
  }
  const seen = new Set<string>();
  raw.exceptions.forEach((e, i) => {
    const at = `exceptions[${i}]`;
    if (!isRecord(e)) return void errors.push(`${at}: not an object`);
    for (const k of Object.keys(e)) {
      if (!EXCEPTION_KEYS.includes(k)) errors.push(`${at}: unknown field "${sanitize(k, 30)}"`);
    }
    const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "");
    const before = errors.length;
    if (!GHSA_RE.test(str("advisoryId")) || str("advisoryId").length !== 19)
      errors.push(`${at}: advisoryId must be an exact GHSA identifier`);
    if (!PACKAGE_NAME_RE.test(str("package")))
      errors.push(`${at}: package must be one exact npm package name (no wildcards)`);
    if (!parseRange(str("versionRange")))
      errors.push(`${at}: versionRange must be AND-only comparators with an upper bound, e.g. ">=1.0.0 <1.2.3"`);
    if (e.scope !== "production" && e.scope !== "development")
      errors.push(`${at}: scope must be "production" or "development"`);
    if (str("rationale").trim().length < 20) errors.push(`${at}: rationale must be at least 20 characters`);
    if (!/^@?[A-Za-z0-9-]{1,39}$/.test(str("owner"))) errors.push(`${at}: owner must be a GitHub handle`);
    const exp = expiryMs(str("expires"));
    if (exp === null) errors.push(`${at}: expires must be a real YYYY-MM-DD date`);
    else if (exp - now.getTime() > maxDays * DAY_MS)
      errors.push(`${at}: expires is more than ${maxDays} days away`);
    const key = `${str("advisoryId")}|${str("package")}|${str("scope")}|${str("versionRange")}`;
    if (seen.has(key)) errors.push(`${at}: duplicate exception`);
    seen.add(key);
    if (errors.length === before) exceptions.push(e as unknown as AdvisoryException);
  });
  return { exceptions, errors: errors.slice(0, MAX_ERRORS) };
}

// ---------------------------------------------------------------------------
// Scanner report parsing (npm audit --json, auditReportVersion 2)
// ---------------------------------------------------------------------------

interface RawFinding extends Omit<Finding, "disposition"> {}
type Parsed =
  | { ok: true; findings: RawFinding[] }
  | { ok: false; status: "malformed-output" | "scanner-failure"; errors: string[] };

function parseReport(report: unknown, lockfile: Lockfile): Parsed {
  const bad = (errors: string[]): Parsed => ({
    ok: false,
    status: "malformed-output",
    errors: errors.slice(0, MAX_ERRORS),
  });
  if (!isRecord(report)) return bad(["scanner output is not a JSON object"]);
  if ("error" in report) {
    const err = report.error;
    const code = isRecord(err) && typeof err.code === "string" ? sanitize(err.code, 40) : "unknown";
    return { ok: false, status: "scanner-failure", errors: [`scanner reported an error (code: ${code})`] };
  }
  if (report.auditReportVersion !== 2) return bad(["unsupported or missing auditReportVersion (expected 2)"]);
  if (!isRecord(report.vulnerabilities)) return bad(["vulnerabilities is missing or not an object"]);
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) return bad(["lockfile has no packages map"]);

  const errors: string[] = [];
  const findings = new Map<string, RawFinding>();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    const label = sanitize(name, 60);
    if (!isRecord(entry) || !Array.isArray(entry.nodes) || !Array.isArray(entry.via)) {
      errors.push(`vulnerabilities.${label}: unexpected shape`);
      continue;
    }
    const advisories: { id: string; severity: Severity; title: string }[] = [];
    for (const via of entry.via) {
      if (typeof via === "string") continue; // derived from another entry; root advisory is reported there
      if (!isRecord(via) || via.name !== name || !isSeverity(via.severity)) {
        errors.push(`vulnerabilities.${label}: advisory has unexpected shape`);
        continue;
      }
      const url = typeof via.url === "string" ? via.url : "";
      const id =
        GHSA_RE.exec(url)?.[0] ??
        (typeof via.source === "number" ? `npm-advisory-${via.source}` : null);
      if (!id) {
        errors.push(`vulnerabilities.${label}: advisory has no identity`);
        continue;
      }
      advisories.push({
        id,
        severity: via.severity,
        title: typeof via.title === "string" ? sanitize(via.title, 120) : "",
      });
    }
    if (advisories.length === 0) continue;
    for (const nodePath of entry.nodes) {
      const pkg = typeof nodePath === "string" ? lockfile.packages[nodePath] : undefined;
      if (typeof nodePath !== "string" || !pkg || typeof pkg.version !== "string") {
        errors.push(`vulnerabilities.${label}: installed path missing from lockfile`);
        continue;
      }
      const scope: Scope = pkg.dev === true ? "development" : "production";
      for (const a of advisories) {
        findings.set(`${a.id}|${nodePath}`, {
          advisoryId: a.id,
          package: name,
          version: pkg.version,
          nodePath,
          scope,
          severity: a.severity,
          title: a.title,
        });
      }
    }
  }
  return errors.length > 0 ? bad(errors) : { ok: true, findings: [...findings.values()] };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluateAdvisoryPolicy(input: {
  report: unknown;
  lockfile: Lockfile;
  exceptions: unknown;
  now: Date;
  options?: PolicyOptions;
}): PolicyResult {
  const minSeverity = input.options?.minBlockingSeverity ?? "low";
  const maxDays = input.options?.maxExceptionDays ?? 180;
  const fail = (status: PolicyStatus, errors: string[]): PolicyResult => ({
    status,
    findings: [],
    unusedExceptions: [],
    errors,
  });

  const parsed = parseReport(input.report, input.lockfile);
  if (!parsed.ok) return fail(parsed.status, parsed.errors);

  const ex = validateExceptions(input.exceptions, input.now, maxDays);
  if (ex.errors.length > 0) return fail("invalid-exceptions", ex.errors);

  const used = new Set<AdvisoryException>();
  const nowMs = input.now.getTime();
  const findings: Finding[] = parsed.findings.map((f) => {
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[minSeverity]) {
      return { ...f, disposition: "below-threshold" };
    }
    const matches = ex.exceptions.filter(
      (e) =>
        e.advisoryId === f.advisoryId &&
        e.package === f.package &&
        e.scope === f.scope &&
        versionInRange(f.version, e.versionRange),
    );
    matches.forEach((m) => used.add(m));
    if (matches.some((m) => (expiryMs(m.expires) as number) >= nowMs)) {
      return { ...f, disposition: "excepted" };
    }
    return { ...f, disposition: matches.length > 0 ? "expired-exception" : "blocking" };
  });

  const has = (d: Disposition) => findings.some((f) => f.disposition === d);
  const status: PolicyStatus = has("blocking")
    ? "policy-violation"
    : has("expired-exception")
      ? "expired-exception"
      : "pass";
  return {
    status,
    findings,
    unusedExceptions: ex.exceptions.filter((e) => !used.has(e)),
    errors: [],
  };
}

/** Distinct exit codes so the workflow can tell a violation from a broken scan. 0 is reserved for "pass". */
export function exitCodeFor(status: PolicyStatus): number {
  switch (status) {
    case "pass":
      return 0;
    case "policy-violation":
    case "expired-exception":
      return 1;
    case "malformed-output":
    case "invalid-exceptions":
      return 2;
    case "scanner-failure":
      return 3;
  }
}

/** Redacted Markdown summary: identifiers, versions and paths only. */
export function renderSummary(result: PolicyResult): string {
  const lines = [`## Dependency advisory gate: \`${result.status}\``, ""];
  const rows = result.findings.filter((f) => f.disposition !== "below-threshold");
  if (rows.length > 0) {
    lines.push("| Disposition | Advisory | Package | Version | Scope | Severity | Path |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const f of rows) {
      lines.push(
        `| ${f.disposition} | ${f.advisoryId} | ${f.package} | ${f.version} | ${f.scope} | ${f.severity} | \`${f.nodePath}\` |`,
      );
    }
    lines.push("");
  }
  result.errors.forEach((e) => lines.push(`- error: ${e}`));
  result.unusedExceptions.forEach((e) =>
    lines.push(`- unused exception (consider removing): ${e.advisoryId} ${e.package} ${e.versionRange}`),
  );
  lines.push(
    "",
    "_A pass means no policy-blocking findings in the scanned lockfile scope according to the advisory data available at run time. It is not proof that no vulnerabilities exist._",
  );
  return lines.join("\n");
}
