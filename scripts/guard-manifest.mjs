#!/usr/bin/env node
/* Manifest permission-diff guard -- Headsmith invariant 6 (least permission).
 *
 * An extension's permission set is the one thing a user cannot audit after
 * install and cannot partially decline. It is also the easiest thing to widen
 * by accident: a library that wants `tabs`, a feature that "just needs"
 * `cookies`, a manifest key added to silence a warning. Chrome will re-prompt
 * on some additions and silently accept others.
 *
 * So the permission set is treated as a reviewed artifact. It lives in
 * scripts/permissions-baseline.json, and any drift between that file and the
 * built manifest fails CI. Widening it takes three things in the same PR:
 *
 *   1. the baseline file updated,
 *   2. a SECURITY.md entry explaining why (checked here),
 *   3. the `permissions-change` label on the PR (checked in ci.yml, because
 *      only the workflow can see labels).
 *
 * Narrowing the set is allowed to pass with a note -- removing a permission is
 * never the change that needs a gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './lib/scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'permissions-baseline.json');
const securityPath = join(root, 'SECURITY.md');

/* WXT names the Chrome MV3 output directory after the target. */
const candidates = ['chrome-mv3', 'chrome'].map((d) => join(root, 'dist', d, 'manifest.json'));
const manifestPath = candidates.find((p) => existsSync(p));

if (!manifestPath) {
  console.error('\n✗ manifest guard: no built manifest found. Run `npm run build` first.\n');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const failures = [];
const notes = [];

const KEYS = ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions'];

for (const key of KEYS) {
  const actual = [...(manifest[key] ?? [])].sort();
  const expected = [...(baseline[key] ?? [])].sort();

  const added = actual.filter((p) => !expected.includes(p));
  const removed = expected.filter((p) => !actual.includes(p));

  for (const p of added) {
    failures.push(
      `${key}: "${p}" is in the built manifest but not in the baseline. ` +
        `Widening the permission set needs a baseline update, a SECURITY.md entry, and the permissions-change label.`,
    );
  }
  for (const p of removed) {
    notes.push(`${key}: "${p}" removed since the baseline -- update scripts/permissions-baseline.json to match`);
  }
  if (!added.length && !removed.length && actual.length) {
    notes.push(`${key}: ${actual.length} entry(ies), unchanged`);
  }
}

/* Every permission must carry a written justification. An entry nobody could
   explain is an entry that should not be there. */
const justifications = baseline.justifications ?? {};
for (const key of ['permissions', 'host_permissions']) {
  for (const p of manifest[key] ?? []) {
    if (!justifications[p] || justifications[p].trim().length < 20) {
      failures.push(`${key}: "${p}" has no justification in permissions-baseline.json`);
    }
  }
}

/* <all_urls> is the one grant that genuinely cannot be narrowed, so the
   kickoff requires it be argued for in SECURITY.md rather than assumed. */
if ((manifest.host_permissions ?? []).includes('<all_urls>')) {
  if (!existsSync(securityPath)) {
    failures.push('host_permissions includes <all_urls> but SECURITY.md does not exist');
  } else {
    const security = readFileSync(securityPath, 'utf8');
    if (!security.includes('<all_urls>')) {
      failures.push('host_permissions includes <all_urls> but SECURITY.md never mentions it');
    }
  }
}

/* Permissions that would break the product's central claim. `webRequest` in
   particular is the line between "hands rules to the browser" and "sees every
   request", and no feature is worth crossing it. */
const FORBIDDEN = [
  'webRequest',
  'webRequestBlocking',
  'webRequestAuthProvider',
  'debugger',
  'nativeMessaging',
  'management',
  'proxy',
  'privacy',
  'history',
  'browsingData',
  'downloads',
  'cookies',
  'clipboardRead',
  'declarativeNetRequestFeedback',
];
for (const key of ['permissions', 'optional_permissions']) {
  for (const p of manifest[key] ?? []) {
    if (FORBIDDEN.includes(p)) {
      failures.push(
        `${key}: "${p}" is forbidden outright -- it would let the extension observe or alter traffic and state beyond declarative header rules. See SECURITY.md.`,
      );
    }
  }
}

notes.unshift(`baseline: ${manifestPath.replace(root + '/', '')}`);
process.exit(report('manifest permission guard', failures, notes));
