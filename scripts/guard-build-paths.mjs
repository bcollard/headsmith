#!/usr/bin/env node
/* Build-path guard.
 *
 * Nothing in the shipped output may contain an absolute filesystem path.
 *
 * This exists because the reproducible-build claim died quietly once and
 * nothing noticed. Vite 8 bundles Rolldown, which annotates unminified chunks
 * with `//#region <module id>` markers; WXT builds its entrypoint ids as
 * `virtual:wxt-<name>-entrypoint?<inputPath>` with an absolute inputPath. So
 * every chunk carried the path of the checkout it was built in --
 * `/home/runner/work/headsmith/headsmith` on CI, a home directory anywhere
 * else -- and the artifact became a function of *where* it was built rather
 * than of the source alone.
 *
 * v1.4.0 (Vite 7, no markers) reproduced. The first Vite 8 build did not, and
 * differed from a local rebuild by exactly those bytes. The existing check
 * could not catch it: `verify-reproducible.mjs --self` builds twice in the
 * same directory, where the embedded path is identical both times and the two
 * artifacts match perfectly.
 *
 * So this guard asserts the property directly rather than by comparison, and
 * a path-dependent build now fails `npm run guard` on the machine that made
 * it -- not months later, in someone else's verification attempt.
 *
 * It is also a small privacy fix in its own right: the old artifacts shipped
 * the builder's directory layout to everyone who installed the extension.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesWithExt, read, rel, report } from './lib/scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = ['chrome-mv3', 'chrome'].map((d) => join(root, 'dist', d));
const distDir = candidates.find((d) => existsSync(join(d, 'manifest.json')));

if (!distDir) {
  console.error('\n✗ build-path guard: no built output found. Run `npm run build` first.\n');
  process.exit(1);
}

/* Two separate questions, because each catches what the other cannot.
 *
 * `root` catches a path baked in by *this* build, which is the common case and
 * the one a developer can act on immediately. The generic prefixes catch a
 * path baked in somewhere else -- a committed artifact, a vendored bundle, a
 * dependency shipping its own build directory -- which `root` would miss
 * entirely because it never matches another machine's layout. */
const homePrefixes = [
  { re: /\/home\/[A-Za-z0-9._-]+\//g, what: 'a Linux home directory' },
  { re: /\/Users\/[A-Za-z0-9._@-]+\//g, what: 'a macOS home directory' },
  { re: /[A-Za-z]:\\\\?Users\\\\?/g, what: 'a Windows user directory' },
];

const failures = [];
const notes = [];

/* Text formats only. A path inside a PNG would be a genuine finding too, but
 * the icons are generated from scripts/lib/logo.mjs and guard-manifest-refs
 * already pins what ships, so scanning binaries here would cost more in false
 * positives on compressed bytes than it could plausibly catch. */
const files = filesWithExt(distDir, ['.js', '.mjs', '.css', '.html', '.json', '.map']);

for (const file of files) {
  const text = read(file);
  const where = rel(file, distDir);

  if (text.includes(root)) {
    const line = text.slice(0, text.indexOf(root)).split('\n').length;
    failures.push(`${where}:${line}: contains this checkout's absolute path (${root})`);
  }

  for (const { re, what } of homePrefixes) {
    const hit = text.match(re);
    if (!hit) continue;
    // Report one example rather than every occurrence: 33 identical region
    // markers is noise, and the fix is the same for all of them.
    failures.push(`${where}: contains ${what} (${hit[0]}${hit.length > 1 ? `, ×${hit.length}` : ''})`);
  }
}

notes.unshift(`scanned ${files.length} file(s) under ${rel(distDir, root)}`);

if (!failures.length) {
  notes.push('no absolute filesystem paths in the shipped output');
}

process.exit(report('build-path guard', failures, notes));
