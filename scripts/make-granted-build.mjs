#!/usr/bin/env node
/* Produces dist/chrome-granted: the built extension with localhost declared in
 * host_permissions.
 *
 * Needed because host access is now optional and requested at runtime, and
 * `chrome.permissions.request` refuses outside a user gesture -- deliberately,
 * since that is the property that makes the model worth having. Chrome's
 * consent bubble is a native dialog and cannot be driven by a test.
 *
 * So the tests split. Everything up to the click -- no access at install, no
 * effect without access, the grant control offered, the request refusing
 * without a gesture -- runs against the real build. The tests that need a rule
 * to actually apply run against this one, where the host is already held.
 *
 * The alternative was to delete those tests, which would have removed the only
 * coverage proving headers reach the network at all.
 *
 * Test-only. Never packaged: `scripts/pack.mjs` reads dist/chrome.
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'dist', 'chrome');
const target = join(root, 'dist', 'chrome-granted');

if (!existsSync(join(source, 'manifest.json'))) {
  console.error('\n✗ no build at dist/chrome. Run `npm run build` first.\n');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

const manifestPath = join(target, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = ['*://*.localhost/*', 'http://localhost/*'];
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(`✓ dist/chrome-granted — host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
