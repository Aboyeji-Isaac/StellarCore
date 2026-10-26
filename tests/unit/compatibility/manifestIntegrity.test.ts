import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCompatibilityAudit } from "@/lib/api/compatibility/gate";
import {
  buildAndSaveManifest,
  verifyManifestIntegrity,
  writeFixtureFile,
} from "@/lib/api/compatibility/manifest";
import type { CompatibilityFixture } from "@/lib/api/compatibility/types";

test("manifest integrity verifies valid fixtures and detects checksum tampering", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "compat-test-"));
  try {
    const fixture: CompatibilityFixture = {
      name: "sample.fixture",
      domain: "anchors",
      endpoint: "GET /api/anchors",
      method: "GET",
      expectedStatus: 200,
      description: "Test fixture",
      body: { ok: true },
    };

    const relPath = writeFixtureFile(fixture, "anchors", "sample.json", tempDir, "v1");
    buildAndSaveManifest([{ name: fixture.name, path: relPath }], {
      baseDir: tempDir,
      contractVersion: "v1",
    });

    const initialCheck = verifyManifestIntegrity(tempDir, "v1");
    assert.equal(initialCheck.ok, true);

    // Tamper with the fixture content without updating the manifest
    const absPath = join(tempDir, "contracts", "api", "v1", relPath);
    writeFileSync(absPath, '{"tampered": true}\n', "utf8");

    const tamperedCheck = verifyManifestIntegrity(tempDir, "v1");
    assert.equal(tamperedCheck.ok, false);
    assert.equal(
      tamperedCheck.issues.some((issue) => issue.includes("checksum mismatch")),
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manifest integrity detects unregistered files on disk", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "compat-test-"));
  try {
    const fixture: CompatibilityFixture = {
      name: "sample.fixture",
      domain: "anchors",
      endpoint: "GET /api/anchors",
      method: "GET",
      expectedStatus: 200,
      description: "Test fixture",
      body: { ok: true },
    };

    const relPath = writeFixtureFile(fixture, "anchors", "sample.json", tempDir, "v1");
    buildAndSaveManifest([{ name: fixture.name, path: relPath }], {
      baseDir: tempDir,
      contractVersion: "v1",
    });

    // Write an untracked extra fixture
    const unlisted: CompatibilityFixture = {
      name: "unlisted.fixture",
      domain: "anchors",
      endpoint: "GET /api/anchors/unlisted",
      method: "GET",
      expectedStatus: 200,
      description: "Unlisted fixture",
      body: { ok: false },
    };
    writeFixtureFile(unlisted, "anchors", "unlisted.json", tempDir, "v1");

    const check = verifyManifestIntegrity(tempDir, "v1");
    assert.equal(check.ok, false);
    assert.equal(
      check.issues.some((issue) => issue.includes("Unregistered fixture file found")),
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runCompatibilityAudit fails if manifest integrity check fails", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "compat-test-"));
  try {
    const fixture: CompatibilityFixture = {
      name: "anchors.list.success",
      domain: "anchors",
      endpoint: "GET /api/anchors",
      method: "GET",
      expectedStatus: 200,
      description: "Test",
      body: { ok: true },
    };

    const relPath = writeFixtureFile(fixture, "anchors", "sample.json", tempDir, "v1");
    buildAndSaveManifest([{ name: fixture.name, path: relPath }], {
      baseDir: tempDir,
      contractVersion: "v1",
    });

    // Corrupt manifest file
    const manifestPath = join(tempDir, "contracts", "api", "v1", "manifest.json");
    writeFileSync(manifestPath, "invalid json", "utf8");

    const audit = await runCompatibilityAudit({ baseDir: tempDir, contractVersion: "v1" });
    assert.equal(audit.ok, false);
    assert.equal(audit.breakingCount > 0, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
