import { test, expect } from '@playwright/test';

// Deterministic boundary fixture
const BOUNDARY_EVIDENCE_DATA = {
  id: 'evd_999999999999999999999999999999999999999999999999', // Extra long ID
  title: 'This is an exceptionally long evidence title that continues indefinitely to test how the dashboard card handles text wrapping, CSS text-overflow truncation, and flexbox shrinking without pushing adjacent status badges out of the container bounds.',
  amount: 987654321098.7654, // Large fractional number
  status: 'PENDING',
  optionalDescription: null, // Explicitly missing optional value
};

test.describe('Dashboard Layout Resilience', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept the dashboard data API to return our boundary fixture
    await page.route('**/api/evidence*', async (route) => {
      await route.fulfill({ json: { data: [BOUNDARY_EVIDENCE_DATA] } });
    });
  });

  test('desktop layout handles extreme boundary values without overflowing', async ({ page }) => {
    await page.goto('/dashboard');

    const evidenceCard = page.locator('[data-testid="evidence-card"]').first();
    await expect(evidenceCard).toBeVisible();

    // 1. Verify safe fallback for missing values
    // Adjust 'N/A' to match your actual fallback string (e.g., '-', 'None provided')
    await expect(evidenceCard.getByText('N/A', { exact: true })).toBeVisible();

    // 2. Verify large numbers format safely (assuming standard comma formatting)
    await expect(evidenceCard).toContainText('987,654,321,098');

    // 3. Verify no horizontal overflow (overlapping/breaking container)
    const cardBounds = await evidenceCard.boundingBox();
    const viewportWidth = page.viewportSize()?.width || 0;
    expect(cardBounds!.width).toBeLessThanOrEqual(viewportWidth);
    
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalScroll).toBe(false);
  });

  test('mobile viewport maintains usable layout without horizontal scroll', async ({ page }) => {
    // Simulate a narrow mobile viewport (e.g., iPhone SE)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/dashboard');

    const evidenceCard = page.locator('[data-testid="evidence-card"]').first();
    await expect(evidenceCard).toBeVisible();

    // Ensure the long title and large values didn't break the mobile grid/flex layout
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalScroll).toBe(false);
    
    // Ensure the status badge remains inside the viewport
    const statusBadge = evidenceCard.getByText('PENDING');
    const badgeBounds = await statusBadge.boundingBox();
    expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(375);
  });
});