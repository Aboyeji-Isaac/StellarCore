# Dependency-install reproducibility verification

`npm run verify:install-reproducibility` proves that production release builds
install exactly the dependency graph represented by the reviewed lockfile, and
fails when package resolution or lifecycle behavior drifts (issue #237).

## What it does

1. Materializes the reviewed dependency inputs (`package.json`,
   `package-lock.json`, `prisma.config.ts`, `prisma/`) from a git ref with
   `git archive` — never from developer working-tree state. If
   `package.json`/`package-lock.json` differ between the working tree and the
   ref, verification refuses to start; pass `--worktree` to verify the working
   tree explicitly instead.
2. Creates at least two isolated sandboxes under the OS temp directory, copies
   the same reviewed inputs into each, and runs `npm ci --no-audit --no-fund
   --foreground-scripts` with a scrubbed environment: inherited `npm_*`,
   `NODE_OPTIONS`, and `NODE_ENV` variables are dropped, and npm is pointed at
   a sandbox-local cache and empty `.npmrc` so resolution never depends on
   developer machine state.
3. Captures, per run: the installed hidden lockfile
   (`node_modules/.package-lock.json`), a physical `node_modules` scan
   (path → name/version/lifecycle-script marker), a content digest manifest of
   generated artifacts (`app/generated/prisma`), the toolchain identity
   (node/npm versions, platform, arch, libc, reviewed ref, package.json and
   lockfile SHA-256 digests), and whether `npm ci` mutated the reviewed
   lockfile.
4. Compares everything through the normalization rules below and fails the run
   on any fatal difference, writing a bounded diff artifact.

## Normalization rules

Normalization exists to exclude genuinely nondeterministic noise only. No rule
can hide a package, version, integrity, resolved-URL, dependency-edge, or
lifecycle-script change:

- **R1 — path-keyed maps.** Package collections are compared as maps keyed by
  lockfile path; insertion order never affects results.
- **R2 — graph-relevant fields only.** Lockfile entries keep `name`, `version`,
  `resolved`, `integrity`, install flags (`dev`, `optional`, `devOptional`,
  `peer`), `hasInstallScript`, platform gates (`os`, `cpu`, `libc`), `engines`,
  `bin`, and dependency edges. Unrelated fields such as `funding` are dropped.
  Name, version, integrity, and edges are always retained, so no package or
  version change can be normalized away.
- **R3 — canonicalized edges.** Dependency edges are compared as sorted
  name→range maps.
- **R4 — sandbox-path abstraction.** Absolute sandbox paths (including realpath
  variants) are replaced with `<sandbox>` before hashing, so comparisons never
  depend on where the sandboxes live.
- **R5 — content-only artifacts.** File mtimes, sizes, and permissions are
  ignored; generated artifacts are compared by SHA-256 content digest only.
- **R6 — logs are diagnostics.** Raw npm install output is attached to the
  report (normalized tail) but never compared byte-for-byte; only the
  structured install result participates in the verdict.

## Verdict rules

Verification is `not-reproducible` when any fatal check fails:

- `isolated-installs-succeed` — every `npm ci` must exit 0. The observable form
  of package.json/lockfile divergence is npm refusing to install; that is
  reported as a lockfile-sync failure.
- `run-1-vs-run-N:normalized-dependency-graph` — installed hidden lockfiles
  must be identical across runs.
- `run-1-vs-run-N:node-modules-layout` — physical `node_modules` layouts must
  be identical across runs.
- `run-1-vs-run-N:generated-artifacts` — generated artifacts must be identical
  after R4/R5 normalization.
- `run-1-vs-run-N:toolchain` — toolchain identity must be identical across
  runs (and is always recorded in the report).
- `installed-graph-matches-reviewed-lockfile` — every installed package must
  match the reviewed lockfile on name, version, integrity, resolved URL,
  dependency edges, lifecycle-script marker, and `peer` flag. Platform-gated
  optional packages may be legitimately absent (with their subtrees) when the
  reviewed lockfile's `os`/`cpu`/`libc` gates exclude this platform; if such a
  package appears anyway, that is fatal. An optional package without matching
  platform gates must still install when the platform matches.
- `disk-layout-matches-hidden-lockfile` — the physical scan must agree with the
  installed hidden lockfile.
- `lockfile-not-mutated-by-install` — `npm ci` must leave the reviewed
  `package-lock.json` byte-identical.

Non-fatal, reported separately in the report:

- `scope-flag-drift` — `dev`/`devOptional`/`optional` bookkeeping differences
  against the reviewed lockfile. npm minor versions move packages between these
  scopes without changing what resolves or installs. `devOptional` reachability
  subsumes `dev` reachability, so a `dev` difference is not double-reported
  when either side marks the package `devOptional`.
- `toolchain-engines-note` — whether node satisfies `engines.node`. Warning
  only: `npm ci` does not enforce engines, and release CI pins the toolchain.

## Report artifact

Reports are written to `.reports/install-reproducibility/` (gitignored):

- `summary.txt` — human-readable PASS/FAIL per check.
- `report.json` — schema-versioned machine report with the toolchain context,
  normalization rules, per-run metadata, and bounded diffs (at most 50
  differences per check by default, value strings truncated at 240 chars).
- `run-N/install.log` — normalized install log tail per sandbox.
- `run-N/manifests.json` — normalized hidden lockfile graph, physical scan,
  and generated-artifact manifest per run.

## Usage

```bash
# Default: two isolated installs from HEAD
npm run verify:install-reproducibility

# Verify a specific reviewed ref
npm run verify:install-reproducibility -- --ref main

# More runs for flakiness hunting
npm run verify:install-reproducibility -- --runs 3

# Inspect sandboxes and full logs after a failure
npm run verify:install-reproducibility -- --keep-sandboxes

# Verify the uncommitted working tree explicitly (developer-machine mode)
npm run verify:install-reproducibility -- --worktree

# Raise the bounded diff budget
npm run verify:install-reproducibility -- --max-diff 100
```

The script requires network access to the npm registry for the installs
themselves (or a warm shared cache via `--shared-cache`). It is opt-in and is
not run by `npm test`, `npm run build`, or `postinstall`.

## Relationship to other issues

- #142 owns SBOM/build provenance; this verification only proves dependency
  install reproducibility.
- #147 owns advisory/security gates; integrity mismatches detected here are
  reproducibility failures, not vulnerability assessments.
