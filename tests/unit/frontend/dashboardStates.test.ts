import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

const states = read("components/dashboard/SectionStates.tsx");

function block(name: string): string {
  const start = states.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = states.indexOf("export function", start + 1);
  return states.slice(start, next === -1 ? undefined : next);
}

const PANELS = [
  "AnchorsSection",
  "CorridorsSection",
  "ReputationSection",
  "RatePanel",
].map((name) => ({ name, source: read(`components/dashboard/${name}.tsx`) }));

test("loading, empty, and error states expose distinct semantics", () => {
  const loading = block("SectionSkeleton");
  const empty = block("SectionEmpty");
  const error = block("SectionError");

  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /data-state="loading"/);
  assert.match(loading, /Loading \$\{label\}/);

  assert.match(empty, /data-state="empty"/);
  assert.doesNotMatch(empty, /role="(status|alert)"/);
  assert.doesNotMatch(empty, /aria-busy/);

  assert.match(error, /role="alert"/);
  assert.match(error, /data-state="error"/);
});

test("empty state has no loading indicator", () => {
  const empty = block("SectionEmpty");
  assert.doesNotMatch(empty, /animate-pulse|animate-spin|Loading/);
});

test("empty and error messages are never the same string in a panel", () => {
  for (const { name, source } of PANELS) {
    const emptyMessages = [...source.matchAll(/<SectionEmpty message="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(emptyMessages.length > 0, `${name} must render a SectionEmpty`);
    assert.match(source, /<SectionError message=\{result\.body\.error\.message\}/, `${name} must surface API errors`);
    for (const message of emptyMessages) {
      assert.doesNotMatch(message, /loading|failed|error|unavailable/i, `${name} empty copy must not read as loading/failure`);
    }
  }
});
