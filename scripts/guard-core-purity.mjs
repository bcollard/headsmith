#!/usr/bin/env node
/* Core-purity guard.
 *
 * src/core holds the schema, the credential-release policy, the planner, the
 * rule compiler and the vault. It is the layer that decides what the browser
 * is told to do and whether a secret is handed over, and it is pure: no
 * chrome.*, no storage, no network, no clock beyond what is passed in.
 *
 * That purity is not a style preference, it is what makes two things possible:
 *
 *   - the rule compiler can be snapshot-tested against JSON fixtures without a
 *     browser, so "did my refactor change the emitted rules?" is answerable in
 *     milliseconds and in CI;
 *   - "would this profile release a credential?" is decidable from a plain
 *     object, which is what the plaintext-secret test relies on.
 *
 * The eslint config enforces the same rule at author time. This exists because
 * a lint rule can be disabled inline and a CI script that reads the file is
 * harder to wave through -- it also catches an import that reaches chrome.*
 * transitively through src/platform.
 */

import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, read, rel, scanJs, report } from './lib/scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'src', 'core');

const failures = [];
const notes = [];

if (!existsSync(coreDir)) {
  console.log('\n✓ core-purity guard: src/core does not exist yet, nothing to check\n');
  process.exit(0);
}

const BANNED = [
  { re: /\bchrome\s*\./, what: 'a chrome.* API' },
  { re: /\bbrowser\s*\./, what: 'a browser.* API' },
  { re: /\bglobalThis\s*\.\s*(chrome|browser)\b/, what: 'a browser API via globalThis' },
  { re: /\bfetch\s*\(/, what: 'fetch()' },
  { re: /\blocalStorage\b/, what: 'localStorage' },
  { re: /\bsessionStorage\b/, what: 'sessionStorage' },
  { re: /\bindexedDB\b/, what: 'indexedDB' },
  { re: /\bdocument\s*\./, what: 'the DOM' },
  { re: /\bwindow\s*\./, what: 'window' },
];

/* An import that crosses out of src/core defeats the point even if this file
   itself is clean. Only sibling core modules and node: builtins are allowed;
   in practice core imports nothing but zod and itself. */
const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

const files = walk(coreDir).filter((f) => ['.ts', '.tsx'].includes(extname(f)));

for (const file of files) {
  const name = rel(file, root);
  if (/\.(test|spec)\.tsx?$/.test(file)) continue;

  const source = read(file);
  const { code } = scanJs(source);

  for (const { re, what } of BANNED) {
    if (re.test(code)) failures.push(`${name}: reaches ${what}`);
  }

  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      /* Resolve the specifier for real rather than pattern-matching the
         string: `../../platform/dnr` and `../core/../platform/dnr` are the
         same escape and only path resolution catches both. */
      const target = resolve(dirname(file), spec);
      if (relative(coreDir, target).startsWith('..')) {
        failures.push(`${name}: relative import escapes src/core -> ${spec}`);
      }
      continue;
    }
    if (spec.startsWith('node:')) continue;
    if (spec === 'zod' || spec.startsWith('zod/')) continue;
    failures.push(`${name}: imports "${spec}" -- src/core may only depend on zod and itself`);
  }
}

notes.push(`checked ${files.length} file(s) under src/core`);
process.exit(report('core-purity guard', failures, notes));
