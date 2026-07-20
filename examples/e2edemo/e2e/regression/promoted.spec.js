// Staged E2E test. Present on the default branch => promoted into e2e/regression.
const { test, expect } = require('@playwright/test');

test('staged: greeting is present', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#greeting')).toBeVisible();
});
