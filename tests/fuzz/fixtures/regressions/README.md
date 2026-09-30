# Parser regression corpus

Persisted, minimized inputs discovered by the deterministic fuzz suites
(issue #141). Each fixture encodes a parser contract that must never regress:

- `sep1/` — SEP-1 TOML documents and the typed failure (or accepted-state
  invariant) they must continue to produce.
- `sep38/` — SEP-38 JSON payloads and the typed failure (or accepted-state
  invariant) they must continue to produce.

## Adding a fixture

1. Minimize the failing input to the smallest form that still triggers the
   behavior.
2. Save it here with a descriptive kebab-case name
   (e.g. `duplicate-conflicting-asset.json`).
3. Add a focused `.test.ts` assertion loading the fixture and asserting the
   bounded typed failure or invariant.
4. Reference the GitHub issue documenting the finding.

Fixtures are committed inputs — never generated at runtime — so every addition
is reviewed. Never weaken parser validation to make a fixture pass.
