#!/usr/bin/env node
/* Packages dist/ into the .zip uploaded to the Chrome Web Store.
 *
 * Deliberately not `wxt zip` or `zip -r`: both embed mtimes and take entries in
 * filesystem order, which makes the artifact depend on when and where it was
 * built. See scripts/lib/zip.mjs for what that costs.
 *
 * Prints the SHA-256 of the result, which is the number a third party checks
 * against the release attestation.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './lib/scan.mjs';
import { createZip, epochFromEnv } from './lib/zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = ['chrome-mv3', 'chrome'].map((d) => join(root, 'dist', d)).find((d) => existsSync(d));

if (!distDir) {
  console.error('\n✗ pack: no build found. Run `npm run build` first.\n');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'build');
const outPath = join(outDir, `headsmith-${version}.zip`);

const entries = walk(distDir)
  .map((file) => ({
    // Forward slashes regardless of host platform: a backslash is a literal
    // character in a zip entry name, not a separator.
    path: relative(distDir, file).split(sep).join('/'),
    data: readFileSync(file),
  }))
  .filter((e) => !e.path.startsWith('.') && !e.path.endsWith('.map'));

const zip = createZip(entries, { epochMs: epochFromEnv() });
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, zip);

const digest = createHash('sha256').update(zip).digest('hex');

console.log(`\n✓ packed ${entries.length} file(s)\n`);
for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
  console.log(`  ${entry.path}`);
}
console.log(`\n  ${relative(root, outPath)}`);
console.log(`  ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  sha256  ${digest}\n`);

// Consumed by release.yml to publish alongside the artifact.
if (process.env['GITHUB_OUTPUT']) {
  writeFileSync(
    process.env['GITHUB_OUTPUT'],
    `zip_path=${outPath}\nzip_name=${`headsmith-${version}.zip`}\nsha256=${digest}\n`,
    { flag: 'a' },
  );
}
