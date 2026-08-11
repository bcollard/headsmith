/* End-to-end smoke test.
 *
 * Unit tests prove the compiler emits the rule we meant to. Only a real
 * browser proves Chrome will accept it -- declarativeNetRequest rejects an
 * entire batch for one malformed rule, and it does so at runtime with a
 * message that never reaches a unit test. That gap is what this suite covers.
 *
 * The rule-application assertions arrive with slice 3. For now this asserts
 * the extension loads at all, which is the failure the manifest refs guard
 * predicts but cannot prove.
 */

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, '..', 'dist', 'chrome');

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
});

test.afterAll(async () => {
  await context?.close();
});

/* Chrome exposes the loaded extension through its service worker, which is
   also the cheapest proof that the worker parsed and started. */
async function extensionId(): Promise<string> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  return new URL(worker.url()).host;
}

test('the extension loads and its service worker starts', async () => {
  const id = await extensionId();
  expect(id).toMatch(/^[a-z]{32}$/);
});

test('the popup renders without a console error', async () => {
  const id = await extensionId();
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(`chrome-extension://${id}/app.html`);
  await expect(page.locator('#root')).toBeVisible();

  expect(errors).toEqual([]);
  await page.close();
});

test('the popup requests nothing over the network', async () => {
  // The static counterpart of this lives in scripts/guard-egress.mjs, which
  // reads the built bundle. This is the dynamic half: open the page for real
  // and assert that nothing leaves it. A remote font, a beacon or a CDN
  // script would show up here even if it were constructed at runtime in a way
  // a static scan could miss.
  const id = await extensionId();
  const page = await context.newPage();

  const offOrigin: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(`chrome-extension://${id}/`) && !url.startsWith('data:')) {
      offOrigin.push(url);
    }
  });

  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForLoadState('networkidle');

  expect(offOrigin).toEqual([]);
  await page.close();
});
