/* End-to-end tests for the editor.
 *
 * These drive the real extension in a real browser and assert against what
 * Chrome actually accepted -- `chrome.declarativeNetRequest.getDynamicRules()`
 * and `getSessionRules()`. That is the part unit tests cannot reach: the
 * compiler can be proved to emit the rule we meant, but only the browser
 * proves it will take it.
 */

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, '..', 'dist', 'chrome');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

/* Opens the editor at full width so the tabbed layout renders rather than the
   narrow popup one. */
async function openEditor(): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/app.html?expanded=1`);
  await expect(page.locator('.hs-app')).toBeVisible();
  return page;
}

/* Reads the rules Chrome is actually holding, from the worker's own context. */
async function liveRules(): Promise<{ dynamic: unknown[]; session: unknown[] }> {
  const [worker] = context.serviceWorkers();
  return worker!.evaluate(async () => ({
    dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
    session: await chrome.declarativeNetRequest.getSessionRules(),
  }));
}

async function resetConfig(page: Page) {
  await page.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
}

test('a header typed into the editor becomes a rule Chrome accepts', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('X-Environment');
  await page.getByLabel('Header value').first().fill('staging');

  // Scope it, so the rule is specific enough to assert on.
  await page.getByRole('tab', { name: 'scope' }).click();
  await page.getByLabel('Domains', { exact: true }).fill('api.example.com');

  await expect
    .poll(async () => {
      const rules = await liveRules();
      return JSON.stringify(rules.dynamic);
    }, { timeout: 5000 })
    .toContain('x-environment');

  const rules = await liveRules();
  const rule = rules.dynamic[0] as {
    action: { requestHeaders: { header: string; operation: string; value: string }[] };
    condition: { requestDomains: string[] };
  };

  expect(rule.action.requestHeaders[0]).toEqual({
    header: 'x-environment',
    operation: 'set',
    value: 'staging',
  });
  expect(rule.condition.requestDomains).toEqual(['api.example.com']);

  await page.close();
});

test('a credential is offered a secret field, not a value field', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  // The value input is ordinary until the name is recognised.
  await expect(page.getByLabel('Header value').first()).toBeVisible();

  await page.getByLabel('Header name').first().fill('Authorization');

  // It is replaced the moment the name is recognised -- there is no window in
  // which a token could be typed into a field the profile would store.
  await expect(page.getByLabel('Credential value').first()).toBeVisible();
  await expect(page.getByLabel('Header value')).toHaveCount(0);

  await page.close();
});

test('a credential is withheld until the profile names a host', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('Authorization');
  await page.getByLabel('Credential value').first().fill('Bearer e2e-token-value');
  await page.getByRole('button', { name: 'Save' }).click();

  // No scope yet, so nothing should carry the credential.
  await expect(page.getByText(/not being sent|Add a domain|name a domain/i).first()).toBeVisible({
    timeout: 5000,
  });

  const before = await liveRules();
  expect(JSON.stringify(before)).not.toContain('e2e-token-value');

  // Give it a scope, and it should apply -- as a session rule.
  await page.getByRole('tab', { name: 'scope' }).click();
  await page.getByLabel('Domains', { exact: true }).fill('api.example.com');

  await expect
    .poll(async () => JSON.stringify((await liveRules()).session), { timeout: 5000 })
    .toContain('e2e-token-value');

  const after = await liveRules();
  // The credential must never reach the dynamic set, which Chrome persists.
  expect(JSON.stringify(after.dynamic)).not.toContain('e2e-token-value');

  await page.close();
});

test('pausing removes every rule without discarding the configuration', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('X-Paused-Test');
  await page.getByLabel('Header value').first().fill('on');

  await expect
    .poll(async () => JSON.stringify((await liveRules()).dynamic), { timeout: 5000 })
    .toContain('x-paused-test');

  await page.getByLabel('Active').click();

  await expect.poll(async () => (await liveRules()).dynamic.length, { timeout: 5000 }).toBe(0);

  // The header is still configured, just not applied.
  await expect(page.getByLabel('Header name').first()).toHaveValue('X-Paused-Test');

  await page.close();
});

test('the editor makes no network request of any kind', async () => {
  const page = await context.newPage();
  const offOrigin: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('data:')) {
      offOrigin.push(url);
    }
  });

  await page.goto(`chrome-extension://${extensionId}/app.html?expanded=1`);
  await page.getByRole('tab', { name: 'credentials' }).click();
  await page.getByRole('tab', { name: 'settings' }).click();
  await page.waitForLoadState('networkidle');

  expect(offOrigin).toEqual([]);
  await page.close();
});
