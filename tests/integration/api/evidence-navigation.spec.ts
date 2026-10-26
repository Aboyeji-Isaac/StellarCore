import { test, expect } from '@playwright/test';

const PUBLIC_EVIDENCE_VIEWS = [
  '/evidence/summary',
  '/evidence/feed',
  '/evidence/stats',
  '/evidence/directory'
];

test.describe('Evidence View Navigation and Routing', () => {
  for (const view of PUBLIC_EVIDENCE_VIEWS) {
    test(`Loads directly from URL and survives browser refresh: ${view}`, async ({ page }) => {
      // Direct load
      const response = await page.goto(view);
      expect(response?.status()).toBe(200); // Fails on deployment 404
      
      const contentArea = page.locator('main');
      await expect(contentArea).toBeVisible();

      // Refresh preserves the intended view
      await page.reload();
      expect(page.url()).toContain(view);
      await expect(contentArea).toBeVisible();
    });
  }

  test('Browser back/forward navigation maintains correct view state', async ({ page }) => {
    // Navigate sequence
    await page.goto('/evidence/summary');
    await expect(page.locator('h1', { hasText: 'Summary' })).toBeVisible();

    await page.goto('/evidence/feed');
    await expect(page.locator('h1', { hasText: 'Feed' })).toBeVisible();

    // Back navigation does not leave stale content
    await page.goBack();
    await expect(page.locator('h1', { hasText: 'Summary' })).toBeVisible();
    await expect(page.locator('h1', { hasText: 'Feed' })).not.toBeVisible();

    // Forward navigation restores correct content
    await page.goForward();
    await expect(page.locator('h1', { hasText: 'Feed' })).toBeVisible();
  });
});