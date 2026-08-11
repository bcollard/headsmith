#!/usr/bin/env node
/* Verifies that a published Headsmith artifact was built from this source.
 *
 *   node scripts/verify-reproducible.mjs <downloaded.zip>
 *   node scripts/verify-reproducible.mjs --self
 *
 * The gap this closes: the Chrome Web Store signs the .crx itself from an
 * uploaded .zip. The developer never signs anything and nothing links the
 * published bytes to a commit, so "the source is on GitHub" is an assertion
 * rather than a fact you can check. Both reference extensions leave that gap
 * open, and FlexHeader makes it worse by shipping a 439KB minified chunk that
 * nobody can meaningfully diff.
 *
 * Headsmith closes it by making the build a pure function of the source. This
 * script rebuilds and compares, and when the comparison fails it says *what*
 * differs rather than just that something does -- because the overwhelmingly
 * likely cause is a toolchain difference, not tampering, and an honest tool
 * distinguishes the two.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const selfOnly = args.includes('--self');
const target = args.find((a) => !a.startsWith('-'));

if (!selfOnly && !target) {
  console.error(
    '\nUsage:\n' +
      '  node scripts/verify-reproducible.mjs <downloaded.zip>   compare against a published artifact\n' +
      '  node scripts/verify-reproducible.mjs --self             check the build is stable across two runs\n',
  );
  process.exit(2);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function build() {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  rmSync(join(root, 'build'), { recursive: true, force: true });
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  execFileSync('node', ['scripts/pack.mjs'], { cwd: root, stdio: 'pipe' });
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return readFileSync(join(root, 'build', `headsmith-${version}.zip`));
}

// ---------------------------------------------------------------------------
// Minimal zip reader, so a mismatch can be explained per file rather than as
// one opaque hash difference.
// ---------------------------------------------------------------------------

function readZip(buf) {
  const files = new Map();
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function compare(expected, actual) {
  const a = readZip(expected);
  const b = readZip(actual);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differences = [];

  for (const name of names) {
    const left = a.get(name);
    const right = b.get(name);
    if (!left) differences.push(`  + ${name} (only in the local build)`);
    else if (!right) differences.push(`  - ${name} (only in the published artifact)`);
    else if (!left.equals(right)) {
      differences.push(`  ~ ${name} (${left.length} vs ${right.length} bytes)`);
    }
  }
  return differences;
}

// ---------------------------------------------------------------------------

console.log('\nHeadsmith reproducible-build check');
console.log(`  node     ${process.version}`);
try {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
  console.log(`  commit   ${commit}${dirty ? '  (working tree has uncommitted changes)' : ''}`);
} catch {
  console.log('  commit   unavailable (not a git checkout)');
}

console.log('\nBuilding...');
const first = build();
console.log(`  sha256   ${sha256(first)}`);

/* Two builds from the same source must agree before any comparison against a
   published artifact means anything. If they do not, the build is not
   reproducible locally and a mismatch downstream would prove nothing. */
console.log('\nBuilding again to confirm the build is stable...');
const second = build();
console.log(`  sha256   ${sha256(second)}`);

if (!first.equals(second)) {
  console.error('\n✗ the build is not deterministic: two runs of the same source differ\n');
  for (const line of compare(first, second)) console.error(line);
  console.error('');
  process.exit(1);
}
console.log('\n✓ the build is stable across runs');

if (selfOnly) {
  console.log('');
  process.exit(0);
}

const targetPath = join(process.cwd(), target);
if (!existsSync(targetPath) && !existsSync(target)) {
  console.error(`\n✗ not found: ${target}\n`);
  process.exit(1);
}
const published = readFileSync(existsSync(target) ? target : targetPath);

console.log(`\nComparing against ${relative(root, existsSync(target) ? target : targetPath)}`);
console.log(`  sha256   ${sha256(published)}`);

if (published.equals(first)) {
  console.log('\n✓ identical — the published artifact was built from this source\n');
  process.exit(0);
}

console.error('\n✗ the artifacts differ\n');
let differences;
try {
  differences = compare(published, first);
} catch (err) {
  console.error(`  could not read the published archive: ${err.message}\n`);
  process.exit(1);
}

if (differences.length === 0) {
  /* Same contents, different container. Usually a different zip writer or a
     different SOURCE_DATE_EPOCH -- not evidence of anything alarming. */
  console.error('  Every file inside is identical; only the archive framing differs.');
  console.error('  That points at the packaging step, not the extension contents.\n');
  process.exit(1);
}

for (const line of differences) console.error(line);
console.error(
  '\n  Before treating this as tampering, check the obvious causes:\n' +
    `    - a different Node version (this run used ${process.version}; see .nvmrc)\n` +
    '    - a different commit than the release was cut from\n' +
    '    - uncommitted local changes\n' +
    '\n  If none of those explain it, please open a security advisory.\n',
);
process.exit(1);
