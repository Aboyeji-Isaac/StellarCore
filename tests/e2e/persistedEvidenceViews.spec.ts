import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Browser-level regression coverage for the four public persisted-evidence
 * views (Issue #361): anchors, corridors, rated evidence, and reputation.
 *
 * The tests run in Chromium against the same section views the dashboard
 * renders, served with deterministic API fixtures. No database, anchor network,
 * or production credential is required.
 */

type EvidenceView = "anchors" | "corridors" | "rates" | "reputation";

const VIEW_HEADINGS: Readonly<Record<EvidenceView, string>> = Object.freeze({
  anchors: "Anchors",
  corridors: "Corridors",
  rates: "USDC → BRL rate",
  reputation: "Reputation",
});

function view(page: Page, name: EvidenceView): Locator {
  return page.locator(`[data-view="${name}"]`);
}

async function expectHeading(page: Page, name: EvidenceView): Promise<void> {
  await expect(
    view(page, name).getByRole("heading", { level: 2, name: VIEW_HEADINGS[name] }),
    `${name} view must render its expected heading`,
  ).toBeVisible();
}

test.describe("persisted-evidence views — ready", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard?state=ready");
  });

  test("anchors view renders synchronized anchor evidence", async ({ page }) => {
    const anchors = view(page, "anchors");
    await expectHeading(page, "anchors");
    await expect(anchors.getByRole("heading", { level: 3, name: "Alpha Anchor" })).toBeVisible();
    await expect(anchors.getByText("alpha.example")).toBeVisible();
    await expect(anchors.getByText("Synced", { exact: true })).toBeVisible();
    await expect(anchors.getByText("Sync degraded")).toBeVisible();
    await expect(anchors.getByText("1, 24, 38")).toBeVisible();
  });

  test("corridors view renders the reviewed corridor and anchor count", async ({ page }) => {
    const corridors = view(page, "corridors");
    await expectHeading(page, "corridors");
    const row = corridors.getByRole("row").filter({ hasText: "USDC · US" });
    await expect(row).toBeVisible();
    await expect(row.getByText("BRL · BR")).toBeVisible();
    await expect(row.getByRole("cell").last()).toHaveText("2");
  });

  test("rate view renders persisted observations and the published median", async ({ page }) => {
    const rates = view(page, "rates");
    await expectHeading(page, "rates");
    await expect(rates.getByRole("heading", { level: 3, name: "USDC (US) → BRL (BR)" })).toBeVisible();
    await expect(rates.getByText("5.1234")).toBeVisible();
    await expect(rates.getByTestId("rate-evidence-freshness")).toHaveText(/Latest observation captured/);
    await expect(rates.getByRole("row").filter({ hasText: "Alpha Anchor" })).toContainText("5.1000");
    await expect(rates.getByRole("row").filter({ hasText: "Beta Anchor" })).toContainText("5.1468");
  });

  test("reputation view renders the persisted evaluation and score", async ({ page }) => {
    const reputation = view(page, "reputation");
    await expectHeading(page, "reputation");
    await expect(reputation.getByRole("heading", { level: 3, name: "Alpha Anchor" })).toBeVisible();
    await expect(reputation.getByText("Established")).toBeVisible();
    await expect(reputation.getByText("87", { exact: true })).toBeVisible();
    await expect(reputation.getByText("/100")).toBeVisible();
    await expect(reputation.getByText("42")).toBeVisible();
  });
});

test.describe("persisted-evidence views — empty", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard?state=empty");
  });

  test("anchors view renders a clear empty state", async ({ page }) => {
    const anchors = view(page, "anchors");
    await expectHeading(page, "anchors");
    await expect(anchors.getByText("No anchors are currently persisted.")).toBeVisible();
    await expect(anchors.getByRole("alert")).toHaveCount(0);
  });

  test("corridors view renders a clear empty state", async ({ page }) => {
    const corridors = view(page, "corridors");
    await expectHeading(page, "corridors");
    await expect(corridors.getByText("No corridors are currently persisted.")).toBeVisible();
    await expect(corridors.getByRole("alert")).toHaveCount(0);
  });

  test("rate view keeps the median unavailable and explains the missing evidence", async ({ page }) => {
    const rates = view(page, "rates");
    await expectHeading(page, "rates");
    await expect(rates.getByText("Median unavailable")).toBeVisible();
    await expect(
      rates.getByText("No rate observations are currently persisted for this corridor."),
    ).toBeVisible();
    await expect(rates.getByRole("alert")).toHaveCount(0);
  });

  test("reputation view renders a clear empty state", async ({ page }) => {
    const reputation = view(page, "reputation");
    await expectHeading(page, "reputation");
    await expect(reputation.getByText("No anchors are currently persisted.")).toBeVisible();
    await expect(reputation.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("persisted-evidence views — controlled API error", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard?state=error");
  });

  test("anchors view surfaces the safe error without crashing", async ({ page }) => {
    const anchors = view(page, "anchors");
    await expectHeading(page, "anchors");
    await expect(anchors.getByRole("alert").getByTestId("section-error-message")).toHaveText(
      "Unable to load anchors.",
    );
  });

  test("corridors view surfaces the safe error without crashing", async ({ page }) => {
    const corridors = view(page, "corridors");
    await expectHeading(page, "corridors");
    await expect(corridors.getByRole("alert").getByTestId("section-error-message")).toHaveText(
      "Unable to load corridors.",
    );
  });

  test("rate view surfaces the safe error without crashing", async ({ page }) => {
    const rates = view(page, "rates");
    await expectHeading(page, "rates");
    await expect(rates.getByRole("alert").getByTestId("section-error-message")).toHaveText(
      "Unable to read rates.",
    );
  });

  test("reputation view surfaces the safe error without crashing", async ({ page }) => {
    const reputation = view(page, "reputation");
    await expectHeading(page, "reputation");
    await expect(reputation.getByRole("alert").getByTestId("section-error-message")).toHaveText(
      "Unable to load reputation.",
    );
  });
});

test("evidence dashboard navigation reaches the ready view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open ready evidence dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard\?state=ready$/);
  await expect(page.locator('main[data-fixture-state="ready"]')).toBeVisible();
  for (const name of Object.keys(VIEW_HEADINGS) as EvidenceView[]) {
    await expectHeading(page, name);
  }
});
