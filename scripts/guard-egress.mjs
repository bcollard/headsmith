#!/usr/bin/env node
/* Egress guard -- Headsmith invariants 1 and 2.
 *
 *   1. No network egress, ever.
 *   2. No remote subresources.
 *
 * This runs against `dist/`, not against `src/`, and that is the whole point.
 * FlexHeader's shipped v1.9.6.zip loads a stylesheet from fonts.googleapis.com;
 * the tag lives in an entrypoint HTML file that a source-only scan of the React
 * tree walks straight past. It only becomes visible in build output. Any guard
 * that reads source and not artifact would have missed the one real bug in the
 * reference project it was modelled on.
 *
 * Three separate checks, because the ways a page reaches the network are not
 * the same kind of thing:
 *
 *   a) JS network primitives  -- fetch, XHR, WebSocket, sendBeacon, EventSource,
 *      importScripts, native messaging, setUninstallURL.
 *   b) HTML subresources      -- any src/href/action pointing off-origin.
 *   c) CSS remote references  -- url() and @import pointing off-origin.
 *
 * Allowlisting is deliberately narrow and lives in egress-allowlist.json with a
 * written reason per entry, so adding one shows up in review as a diff to a
 * security file rather than as a tweak to a regex.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, read, rel, scanJs, externalOrigins, report } from './lib/scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(root, 'dist');

const allowlist = JSON.parse(readFileSync(join(root, 'scripts', 'egress-allowlist.json'), 'utf8'));
const allowedOrigins = new Set(allowlist.origins.map((o) => o.host.toLowerCase()));
const namespacePrefixes = allowlist.namespaceUris?.prefixes ?? [];

/* An XML namespace URI is a name, not an address. Recognised structurally by
   exact prefix so that exempting the SVG namespace does not also exempt a
   real subresource fetched from the same host. */
function isNamespaceUri(text) {
  return namespacePrefixes.some((prefix) => text.startsWith(prefix));
}

/* Identifiers that reach the network, or hand execution to something that
   does. Matched against comment-stripped, string-stripped code so a mention
   in a comment or an error message does not trip the guard. */
const NETWORK_PRIMITIVES = [
  { re: /\bfetch\s*\(/, name: 'fetch()' },
  { re: /\bnew\s+XMLHttpRequest\b/, name: 'XMLHttpRequest' },
  { re: /\bnew\s+WebSocket\b/, name: 'WebSocket' },
  { re: /\bnew\s+EventSource\b/, name: 'EventSource' },
  { re: /\bsendBeacon\s*\(/, name: 'navigator.sendBeacon()' },
  { re: /\bimportScripts\s*\(/, name: 'importScripts()' },
  { re: /\bsetUninstallURL\s*\(/, name: 'chrome.runtime.setUninstallURL()' },
  { re: /\bconnectNative\s*\(/, name: 'chrome.runtime.connectNative()' },
  { re: /\bsendNativeMessage\s*\(/, name: 'chrome.runtime.sendNativeMessage()' },
  { re: /\bnavigator\s*\.\s*serviceWorker\b/, name: 'navigator.serviceWorker' },
  /* The vault key must never leave storage.session for a context that could
     be a content script. Default access level is TRUSTED_CONTEXTS; calling
     this at all would widen it. */
  { re: /\bsetAccessLevel\s*\(/, name: 'chrome.storage.session.setAccessLevel()' },
];

/* Vite emits a modulepreload polyfill that calls fetch() on same-origin chunk
   URLs. It is build-tool output, not our code, and it cannot reach off-origin
   -- but it is still a fetch() in the bundle, so it is named explicitly here
   rather than silently tolerated. */
function isAllowedPrimitive(file, primitiveName, code) {
  return allowlist.primitives.some(
    (entry) =>
      entry.primitive === primitiveName &&
      new RegExp(entry.filePattern).test(file) &&
      new RegExp(entry.contextPattern).test(code),
  );
}

const failures = [];
const notes = [];

if (!existsSync(distRoot)) {
  console.error('\n✗ egress guard: dist/ not found. Run `npm run build` first.\n');
  process.exit(1);
}

const files = walk(distRoot);
let jsCount = 0;
let htmlCount = 0;
let cssCount = 0;

for (const file of files) {
  const ext = extname(file).toLowerCase();
  const name = rel(file, root);
  const source = read(file);

  // ---- (a) JS network primitives -------------------------------------
  if (ext === '.js' || ext === '.mjs') {
    jsCount++;
    const { code, strings } = scanJs(source);

    for (const { re, name: primitive } of NETWORK_PRIMITIVES) {
      if (!re.test(code)) continue;
      if (isAllowedPrimitive(name, primitive, code)) {
        notes.push(`allowlisted: ${primitive} in ${name}`);
        continue;
      }
      failures.push(`${name}: uses ${primitive}`);
    }

    /* URL literals in JS. With no network primitive left in the bundle these
       are inert, but an unexplained external origin in shipped code is worth
       a human deciding about, so it fails rather than warns. */
    for (const literal of strings) {
      if (isNamespaceUri(literal.trim())) continue;
      for (const origin of externalOrigins(literal)) {
        const host = origin.split(':')[0];
        if (allowedOrigins.has(host)) continue;
        failures.push(`${name}: external origin in a string literal: ${origin}`);
      }
    }
  }

  // ---- (b) HTML subresources -----------------------------------------
  if (ext === '.html') {
    htmlCount++;
    /* Any attribute that causes the browser to issue a request. This is the
       check that catches a <link rel="stylesheet" href="https://fonts...">. */
    const attrRe = /\b(src|href|action|srcset|poster|data|formaction)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = attrRe.exec(source)) !== null) {
      const [, attr, value] = m;
      if (!/^https?:\/\//i.test(value) && !/^\/\//.test(value)) continue;
      const host = (externalOrigins(value)[0] ?? value.replace(/^\/\//, '').split('/')[0])
        .split(':')[0]
        .toLowerCase();
      if (allowedOrigins.has(host)) continue;
      failures.push(`${name}: remote subresource in ${attr}="${value}"`);
    }

    /* preconnect/dns-prefetch do not fetch a subresource but do leak the
       user's IP and timing to the host the moment the page opens. */
    const linkRe = /<link\b[^>]*rel\s*=\s*["'](preconnect|dns-prefetch|preload|prefetch)["'][^>]*>/gi;
    while ((m = linkRe.exec(source)) !== null) {
      const tag = m[0];
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
      if (!/^https?:\/\//i.test(href) && !/^\/\//.test(href)) continue;
      const host = (externalOrigins(href)[0] ?? href.replace(/^\/\//, '').split('/')[0])
        .split(':')[0]
        .toLowerCase();
      if (allowedOrigins.has(host)) continue;
      failures.push(`${name}: <link rel="${m[1]}"> to ${href}`);
    }

    /* Inline <script> gets the same primitive scan as a .js file. */
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = scriptRe.exec(source)) !== null) {
      const { code } = scanJs(m[1]);
      for (const { re, name: primitive } of NETWORK_PRIMITIVES) {
        if (re.test(code)) failures.push(`${name}: inline <script> uses ${primitive}`);
      }
    }
  }

  // ---- (c) CSS remote references --------------------------------------
  if (ext === '.css') {
    cssCount++;
    const urlRe = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m;
    while ((m = urlRe.exec(source)) !== null) {
      const value = m[1].trim();
      if (!/^https?:\/\//i.test(value) && !/^\/\//.test(value)) continue;
      const host = (externalOrigins(value)[0] ?? value.replace(/^\/\//, '').split('/')[0])
        .split(':')[0]
        .toLowerCase();
      if (allowedOrigins.has(host)) continue;
      failures.push(`${name}: remote url() -> ${value}`);
    }
    const importRe = /@import\s+(?:url\s*\(\s*)?["']([^"']+)["']/gi;
    while ((m = importRe.exec(source)) !== null) {
      if (!/^https?:\/\//i.test(m[1]) && !/^\/\//.test(m[1])) continue;
      failures.push(`${name}: remote @import -> ${m[1]}`);
    }
  }
}

notes.unshift(`scanned ${jsCount} js, ${htmlCount} html, ${cssCount} css file(s) under dist/`);
process.exit(report('egress guard', failures, notes));
