/* Shared scanning helpers for the CI guards.
   Plain Node, no dependencies -- these run before `npm ci` is trusted. */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function filesWithExt(dir, exts) {
  return walk(dir).filter((f) => exts.includes(extname(f).toLowerCase()));
}

export function read(file) {
  return readFileSync(file, 'utf8');
}

export function rel(file, root) {
  return relative(root, file);
}

/* Strips JS comments and returns both the code with comments blanked out and
   the list of string-literal contents.

   Guards scan built output, where `minify: false` means our own source
   comments survive into the bundle. A comment mentioning a URL is inert, a
   string literal holding one is not, so the two must be told apart. A full
   parser would be more correct; this hand-rolled scanner is deliberate --
   the guards must run with zero dependencies, because a guard that trusts
   node_modules to verify node_modules is not a guard. It tracks quotes,
   template literals, regex-vs-division and escapes, which covers real bundler
   output. Anything it gets wrong fails toward reporting more, not less. */
export function scanJs(source) {
  const strings = [];
  let code = '';
  let i = 0;
  const n = source.length;

  // Tracks whether a `/` starts a regex or is division, by remembering the
  // last significant character.
  let lastSignificant = '';

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // String literal
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let value = '';
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        value += source[i];
        i++;
      }
      i++;
      strings.push(value);
      code += quote + quote;
      lastSignificant = quote;
      continue;
    }

    // Regex literal -- skipped so its contents are not mistaken for code.
    if (c === '/' && !/[\w)\]]/.test(lastSignificant)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        else if (source[i] === '\n') break;
        i++;
      }
      i++;
      code += '/re/';
      lastSignificant = '/';
      continue;
    }

    code += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }

  return { code, strings };
}

/* Every http(s) origin appearing in a piece of text. */
export function externalOrigins(text) {
  const found = new Set();
  const re = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

export function report(name, failures, extra = []) {
  for (const line of extra) console.log(`  ${line}`);
  if (failures.length === 0) {
    console.log(`\n✓ ${name}: clean\n`);
    return 0;
  }
  console.error(`\n✗ ${name}: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  return 1;
}
