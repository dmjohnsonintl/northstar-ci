const { test, expect } = require('@playwright/test');

test('home page shows the greeting', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#greeting')).toHaveText('Hello, Northstar');
});
