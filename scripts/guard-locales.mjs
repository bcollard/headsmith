#!/usr/bin/env node
/* Locale guard.
 *
 * A half-translated release is invisible until someone installs it in the
 * wrong language, and a store field over its limit is invisible until the
 * dashboard rejects the upload. Both are cheap to check here and expensive to
 * discover there.
 *
 * Four checks, in the order they tend to fail:
 *
 *   1. Every `__MSG_key__` in the built manifest resolves in the default
 *      locale. An unresolved placeholder does not degrade -- Chrome refuses to
 *      load the extension at all.
 *   2. Every locale carries exactly the same key set as the default. Adding a
 *      string to `en` and forgetting the others is the common failure, and it
 *      renders as a blank or a raw key.
 *   3. Store field limits: name 75, summary 132. The dashboard enforces these
 *      and says so unhelpfully.
 *   4. The summary is plain text. Newlines and HTML are rejected.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './lib/scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(root, 'src', 'public', '_locales');
const distDir = ['chrome-mv3', 'chrome'].map((d) => join(root, 'dist', d)).find((d) =>
  existsSync(join(d, 'manifest.json')),
);

const failures = [];
const notes = [];

/* Store field limits, from the Web Store listing requirements. */
const LIMITS = { extName: 75, extDescription: 132 };

if (!existsSync(localesDir)) {
  console.log('\n✓ locale guard: no _locales directory, nothing to check\n');
  process.exit(0);
}

const locales = readdirSync(localesDir).filter((d) =>
  existsSync(join(localesDir, d, 'messages.json')),
);
if (locales.length === 0) {
  failures.push('_locales exists but contains no messages.json');
}

const read = (locale) => JSON.parse(readFileSync(join(localesDir, locale, 'messages.json'), 'utf8'));

/* The default locale is the contract every other locale is measured against. */
const defaultLocale = 'en';
if (!locales.includes(defaultLocale)) {
  failures.push(`no "${defaultLocale}" locale, but the manifest names it as default_locale`);
}

const base = locales.includes(defaultLocale) ? read(defaultLocale) : {};
const baseKeys = new Set(Object.keys(base));

for (const locale of locales) {
  const messages = read(locale);
  const keys = new Set(Object.keys(messages));

  for (const key of baseKeys) {
    if (!keys.has(key)) failures.push(`${locale}: missing key "${key}" (present in ${defaultLocale})`);
  }
  for (const key of keys) {
    if (!baseKeys.has(key)) failures.push(`${locale}: extra key "${key}" (absent from ${defaultLocale})`);
  }

  for (const [key, limit] of Object.entries(LIMITS)) {
    const value = messages[key]?.message;
    if (typeof value !== 'string') continue;
    if (value.length > limit) {
      failures.push(`${locale}: "${key}" is ${value.length} chars, over the ${limit} limit`);
    }
    if (key === 'extDescription' && /[\r\n<>]/.test(value)) {
      failures.push(`${locale}: the summary must be plain text — no newlines or angle brackets`);
    }
  }

  notes.push(
    `${locale}: ${keys.size} key(s), name ${messages['extName']?.message?.length ?? 0}/${LIMITS.extName}, summary ${messages['extDescription']?.message?.length ?? 0}/${LIMITS.extDescription}`,
  );
}

/* Every placeholder in the built manifest has to resolve, or the extension
   will not load at all. Checked against the build rather than the config,
   since that is what Chrome reads. */
if (distDir) {
  const manifest = readFileSync(join(distDir, 'manifest.json'), 'utf8');
  const referenced = [...manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
  for (const key of new Set(referenced)) {
    if (!baseKeys.has(key)) {
      failures.push(`manifest references __MSG_${key}__ which ${defaultLocale} does not define`);
    }
  }
  notes.push(`manifest: ${new Set(referenced).size} placeholder(s), all checked`);

  if (referenced.length > 0 && !JSON.parse(manifest).default_locale) {
    failures.push('manifest uses __MSG_ placeholders but sets no default_locale — Chrome rejects this');
  }
} else {
  notes.push('no build found; manifest placeholders not checked');
}

process.exit(report('locale guard', failures, notes));
