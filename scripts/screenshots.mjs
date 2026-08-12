#!/usr/bin/env node
/* Generates the Chrome Web Store screenshots.
 *
 *   npm run build && npm run screenshots
 *
 * The store wants exactly 1280x800 (or 640x400) and rejects anything else.
 * Capturing by hand through DevTools does not produce that on a Retina
 * machine: the panel captures at the display's device pixel ratio, so a
 * 1280x800 viewport is written out as 2560x1600 and refused. There is a way
 * to force the ratio in the device toolbar, but it is fiddly, easy to forget,
 * and has to be done again for every shot on every release.
 *
 * So the size is set explicitly here -- `deviceScaleFactor: 1` is the line
 * that matters -- and the content is scripted, which also means the shots are
 * reproducible rather than depending on whatever state the browser happened to
 * be in.
 *
 * Development-only. Not shipped.
 */

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'dist', 'chrome');
const outDir = join(root, 'assets', 'store', 'screenshots');

const WIDTH = 1280;
const HEIGHT = 800;

if (!existsSync(join(extension, 'manifest.json'))) {
  console.error('\n✗ no build found at dist/chrome. Run `npm run build` first.\n');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/* Cleared first. A leftover from an earlier run sits in the directory you
   upload from, at whatever size it happened to be -- and the store rejects the
   whole submission for one wrong-sized image, without saying which. */
for (const stale of readdirSync(outDir).filter((f) => f.endsWith('.png'))) {
  rmSync(join(outDir, stale));
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: false, // extensions do not load headless
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1, // the whole point: 1 CSS pixel per image pixel
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    // Off-screen, so generating these does not take over the display.
    ...(process.env['HEADED'] ? [] : ['--window-position=-32000,-32000']),
  ],
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;

const shots = [];
const shoot = async (page, name) => {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  shots.push(name);
};

// ---- the full editor -------------------------------------------------
const app = await context.newPage();
await app.goto(`chrome-extension://${id}/app.html?expanded=1`);

/* Realistic content. The most common store rejection for a developer tool is
   screenshots that do not demonstrate the described functionality, so these
   show a profile someone might actually have rather than "test / test". */
await app.getByLabel('Profile', { exact: true }).fill('Staging API');
await app.getByLabel('Header name').first().fill('X-Environment');
await app.getByLabel('Header value').first().fill('staging');
await app.getByRole('button', { name: 'Add request header' }).click();
await app.getByLabel('Header name').nth(1).fill('Authorization');
await app.getByLabel('Credential value').first().fill('Bearer eyJhbGciOiJIUzI1NiJ9.demo');
await app.getByRole('button', { name: 'Save' }).click();

await app.getByRole('tab', { name: 'scope' }).click();
await app.getByLabel('Domains', { exact: true }).fill('api.example.com\nstaging.example.com');
await app.getByRole('tab', { name: 'headers' }).click();
await app.waitForTimeout(800);
await shoot(app, '1-headers');

await app.getByRole('tab', { name: 'scope' }).click();
await app.waitForTimeout(400);
await shoot(app, '2-scope');

await app.getByRole('tab', { name: 'credentials' }).click();
await app.waitForTimeout(400);
await shoot(app, '3-credentials');

// ---- the popup, on a backdrop ---------------------------------------
/* Captured at its real width and then placed on a 1280x800 field, because the
   popup is the surface most people will actually use and a 420px image would
   be upscaled into mush by the store. */
const popup = await context.newPage();
await popup.setViewportSize({ width: 420, height: 660 });
await popup.goto(`chrome-extension://${id}/app.html`);
await popup.waitForTimeout(600);
const popupPng = await popup.screenshot();

const stage = await context.newPage();
await stage.setViewportSize({ width: WIDTH, height: HEIGHT });
await stage.setContent(`<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;}
  body{display:grid;place-items:center;background:#fff8f3;font:14px system-ui,sans-serif;}
  figure{margin:0;display:grid;place-items:center;gap:22px;}
  img{width:420px;box-shadow:0 8px 40px rgba(20,22,26,.18);border-radius:10px;display:block;}
  figcaption{color:#5c5651;font-size:15px;}
</style><figure>
  <img src="data:image/png;base64,${popupPng.toString('base64')}" alt="">
  <figcaption>The toolbar popup — headers and scope, without leaving the page</figcaption>
</figure>`);
await stage.waitForTimeout(300);
await shoot(stage, '4-popup');

await context.close();

// ---- verify, rather than assume -------------------------------------
console.log(`\n✓ wrote ${shots.length} screenshot(s) to assets/store/screenshots\n`);
let bad = 0;
for (const name of readdirSync(outDir).filter((f) => f.endsWith('.png')).sort()) {
  const file = join(outDir, name);
  const bytes = readFileSync(file);
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  const ok = w === WIDTH && h === HEIGHT;
  if (!ok) bad++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${name.padEnd(18)} ${w}x${h}  ${(statSync(file).size / 1024).toFixed(0)} KB`,
  );
}
if (bad) {
  console.error(`\n✗ ${bad} screenshot(s) are not ${WIDTH}x${HEIGHT}; the store will reject them.\n`);
  process.exit(1);
}
console.log(`\n  All ${WIDTH}x${HEIGHT}. Ready to upload.\n`);