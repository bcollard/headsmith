import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, 'dist', 'chrome-mv3');

/* End-to-end tests drive the real extension: Chrome loads dist/, the popup is
   opened at chrome-extension://<id>/app.html, and assertions are made against
   the rules the browser actually accepted via chrome.declarativeNetRequest.
   That last part is the reason these exist at all -- unit tests prove we emit
   the rule we meant to, only Chrome proves it will take it.

   `pretest:e2e` builds first. Extensions require a headed browser. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
          ],
        },
      },
    },
  ],
});
