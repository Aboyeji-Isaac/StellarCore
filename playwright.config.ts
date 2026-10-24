import { defineConfig } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4321";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx tests/e2e/support/evidenceFixtureServer.ts",
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
