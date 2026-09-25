import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createStructuredLogger,
  formatLogLine,
  type LogLevel,
} from "@/lib/scheduled/structuredLog";

const FIXED_TIME = new Date("2026-09-25T12:34:56.789Z");

test("a log line is one JSON object with the shared core keys", () => {
  const line = formatLogLine({
    timestamp: FIXED_TIME,
    level: "info",
    script: "snapshot-rates",
    message: "Reviewed rate snapshot run completed",
    fields: { summary: { succeeded: 2 } },
  });

  assert.equal(line.includes("\n"), false);
  assert.deepEqual(JSON.parse(line), {
    timestamp: "2026-09-25T12:34:56.789Z",
    level: "info",
    script: "snapshot-rates",
    message: "Reviewed rate snapshot run completed",
    summary: { succeeded: 2 },
  });
});

test("log lines carry no indentation so one entry maps to one output line", () => {
  const line = formatLogLine({
    timestamp: FIXED_TIME,
    level: "error",
    script: "verify-reputation",
    message: "Reputation evaluation failed",
    fields: { code: "VERIFICATION_FAILURE" },
  });

  assert.equal(line, JSON.stringify({
    timestamp: "2026-09-25T12:34:56.789Z",
    level: "error",
    script: "verify-reputation",
    message: "Reputation evaluation failed",
    code: "VERIFICATION_FAILURE",
  }));
});

test("the injected clock and sink keep logging deterministic for tests", () => {
  const lines: Readonly<{ level: LogLevel; line: string }>[] = [];
  const logger = createStructuredLogger("bootstrap-registry", {
    now: () => FIXED_TIME,
    write: (level, line) => {
      lines.push({ level, line });
    },
  });

  logger.info("Reviewed registry synchronization completed", { summary: { anchors: 3 } });
  logger.error("Reviewed registry synchronization failed", { code: "BOOTSTRAP_FAILURE" });

  assert.deepEqual(lines.map(({ level }) => level), ["info", "error"]);
  assert.deepEqual(JSON.parse(lines[0]!.line), {
    timestamp: "2026-09-25T12:34:56.789Z",
    level: "info",
    script: "bootstrap-registry",
    message: "Reviewed registry synchronization completed",
    summary: { anchors: 3 },
  });
  assert.equal(JSON.parse(lines[1]!.line).code, "BOOTSTRAP_FAILURE");
});

test("fields are optional and the core keys are always present", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger("snapshot-rates", {
    now: () => FIXED_TIME,
    write: (_level, line) => {
      lines.push(line);
    },
  });

  logger.info("no extra fields");

  assert.deepEqual(JSON.parse(lines[0]!), {
    timestamp: "2026-09-25T12:34:56.789Z",
    level: "info",
    script: "snapshot-rates",
    message: "no extra fields",
  });
});

test("every scheduled script logs through the shared structured logger only", () => {
  const scripts: readonly Readonly<{ file: string; name: string }>[] = [
    { file: "bootstrap-registry.ts", name: "bootstrap-registry" },
    { file: "snapshot-rates.ts", name: "snapshot-rates" },
    { file: "verify-reputation.ts", name: "verify-reputation" },
  ];

  for (const script of scripts) {
    const source = readFileSync(
      new URL(`../../../scripts/${script.file}`, import.meta.url),
      "utf8",
    );

    assert.match(
      source,
      new RegExp(`createStructuredLogger\\("${script.name}"\\)`),
      `${script.file} must create the shared logger with a stable script name`,
    );
    assert.match(source, /logger\.info\(/);
    assert.match(source, /logger\.error\(/);
    assert.equal(source.includes("console.log"), false, `${script.file} must not use console.log`);
    assert.equal(source.includes("console.error"), false, `${script.file} must not use console.error`);
    assert.equal(
      source.includes("process.stdout.write"),
      false,
      `${script.file} must not write raw stdout lines`,
    );
  }
});
