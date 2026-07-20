const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npx --yes serve -l 3000 .',
    url: 'http://127.0.0.1:3000/index.html',
    reuseExistingServer: false,
  },
});
