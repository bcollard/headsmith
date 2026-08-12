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
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, '..', 'dist', 'chrome');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    /* Extension e2e requires a headed browser: Playwright's headless shell
       cannot load extensions at all, and real Chrome in new-headless mode does
       not start the service worker. So the window is real -- but parked far
       off-screen, because a test suite that seizes the display of whoever is
       working on the machine is a suite people stop running. CI runs it under
       xvfb, where none of this matters. HEADED=1 brings it back on screen. */
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(process.env['HEADED'] ? [] : ['--window-position=-32000,-32000']),
    ],
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


/* A context whose build already holds localhost, for the tests that need a
   rule to actually apply. See scripts/make-granted-build.mjs for why this is
   necessary and why the alternative was worse. */
const grantedPath = path.join(here, '..', 'dist', 'chrome-granted');

async function withGrantedHost(
  body: (ctx: BrowserContext, extensionId: string) => Promise<void>,
): Promise<void> {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${grantedPath}`,
      `--load-extension=${grantedPath}`,
      ...(process.env['HEADED'] ? [] : ['--window-position=-32000,-32000']),
    ],
  });
  try {
    let worker = ctx.serviceWorkers()[0];
    if (!worker) worker = await ctx.waitForEvent('serviceworker');
    await body(ctx, new URL(worker.url()).host);
  } finally {
    await ctx.close();
  }
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

test('several domains can be typed with Enter between them', async () => {
  /* The field was bound to the parsed list, so pressing Enter produced
     "example.com\n", which parsed to ["example.com"], which rendered back as
     "example.com" -- the newline was destroyed on the keystroke that created
     it and a second line could never be started. Reported from real use. */
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('X-Env');
  await page.getByLabel('Header value').first().fill('staging');
  await page.getByRole('tab', { name: 'scope' }).click();

  const box = page.getByLabel('Domains', { exact: true });
  await box.click();
  await page.keyboard.type('api.example.com');
  await page.keyboard.press('Enter');
  await page.keyboard.type('staging.example.com');
  await page.keyboard.press('Enter');
  await page.keyboard.type('dev.example.com');

  await expect(box).toHaveValue('api.example.com\nstaging.example.com\ndev.example.com');

  await expect
    .poll(async () => {
      const rules = await liveRules();
      return (rules.dynamic[0] as { condition?: { requestDomains?: string[] } })?.condition
        ?.requestDomains;
    }, { timeout: 5000 })
    .toEqual(['api.example.com', 'staging.example.com', 'dev.example.com']);

  await page.close();
});

test('a field is named by its label, not by what is typed into it', async () => {
  /* Nesting a control inside <label> folds everything in the label into the
     control's accessible name -- for a textarea, including its own value. The
     Domains field announced itself as "Domains api.example.com", growing as
     the user typed. */
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();
  await page.getByRole('tab', { name: 'scope' }).click();

  const box = page.getByLabel('Domains', { exact: true });
  await box.click();
  await page.keyboard.type('api.example.com');
  await page.waitForTimeout(200);

  // Still exactly one match after typing, and still named "Domains".
  await expect(page.getByLabel('Domains', { exact: true })).toHaveCount(1);
  await page.close();
});

test('dragging to select text in a header field does not move the row', async () => {
  /* `draggable` sat on the whole row, so the drag that selects text in a name
     or value -- the most common thing anyone does in this table -- reordered
     the row instead. Reported from real use. */
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('X-First');
  await page.getByLabel('Header value').first().fill('one');
  await page.getByRole('button', { name: 'Add request header' }).click();
  await page.getByLabel('Header name').nth(1).fill('X-Second');
  await page.getByLabel('Header value').nth(1).fill('two');

  const firstName = page.getByLabel('Header name').first();
  const box = (await firstName.boundingBox())!;

  // Drag across the text inside the first field, as a person selecting a word.
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 12 });
  // Continue well past the row, which under the old behaviour dropped it below.
  await page.mouse.move(box.x + box.width - 6, box.y + box.height * 3, { steps: 12 });
  await page.mouse.up();

  // Order is unchanged...
  await expect(page.getByLabel('Header name').first()).toHaveValue('X-First');
  await expect(page.getByLabel('Header name').nth(1)).toHaveValue('X-Second');

  // ...and the field really did select text rather than start a drag.
  const selected = await page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el && 'selectionStart' in el
      ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      : '';
  });
  expect(selected.length).toBeGreaterThan(0);

  await page.close();
});

test('the grip still reorders rows', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByLabel('Header name').first().fill('X-First');
  await page.getByRole('button', { name: 'Add request header' }).click();
  await page.getByLabel('Header name').nth(1).fill('X-Second');

  const grip = page.locator('.hs-grip').nth(1);
  const target = page.locator('.hs-header-row').first();
  await grip.dragTo(target);

  await expect(page.getByLabel('Header name').first()).toHaveValue('X-Second');
  await page.close();
});

test('the profile name field is labelled', async () => {
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();
  await expect(page.getByLabel('Profile', { exact: true })).toHaveCount(1);
  await page.close();
});

test('a response header is compiled into the rule', async () => {
  /* Asserts the emitted rule only. Deliberately not "and DevTools shows it":
     the Network panel reports response headers as they arrived from the
     server, before extension modification, so a correctly applied header can
     be absent from it. The test below proves application by observable effect
     instead, which is the only honest way. */
  const page = await openEditor();
  await resetConfig(page);
  await page.reload();

  await page.getByRole('button', { name: 'Add response header' }).click();
  await page.getByLabel('Header name').last().fill('X-Response-Probe');
  await page.getByLabel('Header value').last().fill('delivered');
  await page.getByRole('tab', { name: 'scope' }).click();
  await page.getByLabel('Domains', { exact: true }).fill('localhost');

  await expect
    .poll(async () => JSON.stringify((await liveRules()).dynamic), { timeout: 5000 })
    .toContain('x-response-probe');

  const rule = (await liveRules()).dynamic[0] as {
    action: { responseHeaders?: { header: string; operation: string; value: string }[] };
  };
  expect(rule.action.responseHeaders?.[0]).toEqual({
    header: 'x-response-probe',
    operation: 'set',
    value: 'delivered',
  });

  await page.close();
});

test('a response header really is applied, proved by observable effect', async () => {
  /* The only trustworthy check. Both obvious ones lie: DevTools shows
     pre-modification headers, and a cross-origin fetch().headers.get() returns
     null for any non-safelisted header whether or not it arrived.

     Overriding Content-Type is different in kind -- Chrome has to have read the
     modified value to parse the body the way it did, so the parse result is
     the evidence. */
  const server = spawn('node', ['scripts/echo-server.mjs'], { cwd: process.cwd(), stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    await withGrantedHost(async (ctx, extId) => {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.goto(`chrome-extension://${extId}/app.html?expanded=1`);

      await page.getByRole('button', { name: 'Add response header' }).click();
      await page.getByLabel('Header name').last().fill('Content-Type');
      await page.getByLabel('Header value').last().fill('text/plain');
      await page.getByRole('tab', { name: 'scope' }).click();
      await page.getByLabel('Domains', { exact: true }).fill('localhost');
      await page.waitForTimeout(1300);

      const target = await ctx.newPage();
      await target.goto('http://localhost:8787/headers.json', { waitUntil: 'load' });

      // The endpoint serves application/json. Anything else means the override
      // was read by the parser.
      expect(await target.evaluate(() => document.contentType)).toBe('text/plain');
    });
  } finally {
    server.kill();
  }
});

test('the documented way to check a response header actually works', async () => {
  /* The UI tells people to run
       (await fetch(location.href)).headers.get('Name')
     in the page console. Advice in a product is a promise, so it is tested
     like one -- and the same-origin part is load-bearing: the cross-origin
     version returns null whether or not the header arrived. */
  const server = spawn('node', ['scripts/echo-server.mjs'], { cwd: process.cwd(), stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    await withGrantedHost(async (ctx, extId) => {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.goto(`chrome-extension://${extId}/app.html?expanded=1`);

      await page.getByRole('button', { name: 'Add response header' }).click();
      await page.getByLabel('Header name').last().fill('X-Verify-Me');
      await page.getByLabel('Header value').last().fill('present');
      await page.getByRole('tab', { name: 'scope' }).click();
      await page.getByLabel('Domains', { exact: true }).fill('localhost');
      await page.waitForTimeout(1300);

      const target = await ctx.newPage();
      await target.goto('http://localhost:8787/headers.json', { waitUntil: 'load' });

      const value = await target.evaluate(
        async () => (await fetch(location.href, { cache: 'no-store' })).headers.get('X-Verify-Me'),
      );
      expect(value).toBe('present');
    });
  } finally {
    server.kill();
  }
});

test('a fresh install holds no host access, and rules are inert without it', async () => {
  /* The point of the optional-permission model. What cannot be automated is
     Chrome's consent bubble -- permissions.request() refuses outside a user
     gesture, which is the property that makes this worth doing -- so this
     covers everything up to the click: no access at install, no effect without
     access, and the grant control offered where the scope is set.

     That rules DO apply once a host is granted is covered separately, by
     loading a build whose manifest declares the host outright. */
  const server = spawn('node', ['scripts/echo-server.mjs'], { cwd: process.cwd(), stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    const page = await openEditor();
    await resetConfig(page);
    await page.reload();

    const [worker] = context.serviceWorkers();
    const granted = await worker!.evaluate(() =>
      chrome.permissions.getAll().then((p) => p.origins ?? []),
    );
    expect(granted).toEqual([]);

    await page.getByLabel('Header name').first().fill('X-Needs-Grant');
    await page.getByLabel('Header value').first().fill('yes');
    await page.getByRole('tab', { name: 'scope' }).click();
    await page.getByLabel('Domains', { exact: true }).fill('localhost');

    // The rule is compiled and handed to Chrome...
    await expect
      .poll(async () => JSON.stringify((await liveRules()).dynamic), { timeout: 5000 })
      .toContain('x-needs-grant');

    // ...and Chrome declines to act on it, because the host is not granted.
    const target = await context.newPage();
    await target.goto('http://localhost:8787/headers.json', { waitUntil: 'load' });
    expect(await target.textContent('body')).not.toContain('x-needs-grant');
    await target.close();

    // The way out is offered where the scope was set.
    await expect(page.getByRole('button', { name: /Allow these sites/i })).toBeVisible();
    await page.close();
  } finally {
    server.kill();
  }
});

test('requesting a host refuses without a user gesture', async () => {
  /* Not a limitation to route around -- it is why the model is worth having.
     A host can only ever be added because somebody clicked to add it. */
  const [worker] = context.serviceWorkers();
  const result = await worker!.evaluate(async () => {
    try {
      await chrome.permissions.request({ origins: ['*://*.example.com/*'] });
      return 'granted without a gesture';
    } catch (e) {
      return String((e as Error).message);
    }
  });
  expect(result).toMatch(/user gesture/i);
});
