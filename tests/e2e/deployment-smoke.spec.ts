import { test, expect } from '@playwright/test';

// Enforce explicit target to prevent unsafe implicit execution
const TARGET_URL = process.env.TARGET_URL;

test.describe('Deployment Smoke Check', () => {
  test.beforeAll(() => {
    if (!TARGET_URL) {
      throw new Error('TARGET_URL environment variable must be explicitly supplied to authorize smoke testing.');
    }
  });

  // Four public read-only evidence routes
  const PUBLIC_ROUTES = [
    '/api/evidence/public/latest',
    '/api/evidence/public/stats',
    '/api/evidence/public/summary',
    '/api/evidence/public/feed'
  ];

  for (const route of PUBLIC_ROUTES) {
    test(`API route ${route} serves valid structure and handles empty states`, async ({ request }) => {
      const res = await request.get(`${TARGET_URL}${route}`);
      
      // Verify HTTP status
      expect(res.ok()).toBeTruthy();
      
      const json = await res.json();
      
      // Report empty data distinctly from transport/server errors
      if (Array.isArray(json.data) && json.data.length === 0) {
        expect(json.meta.isEmpty).toBe(true);
      } else {
        expect(json.data).toBeDefined();
      }
    });
  }

  test('Dashboard renders without mutating persisted evidence', async ({ page }) => {
    const res = await page.goto(`${TARGET_URL}/dashboard`);
    expect(res?.status()).toBe(200);
    
    // Verify rendering without interacting with write-capable forms
    const dashboardHeader = page.locator('h1', { hasText: 'Dashboard' });
    await expect(dashboardHeader).toBeVisible();
  });
});