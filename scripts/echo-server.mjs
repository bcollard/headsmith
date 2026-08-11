#!/usr/bin/env node
/* A local echo server for trying Headsmith by hand.
 *
 *   npm run echo     then open http://localhost:8787
 *
 * Shows the request headers the server actually received, and lets the page
 * re-fetch itself so response-header edits are visible too. Local rather than
 * a public echo service on purpose: testing a privacy extension should not
 * require sending your headers to somebody else, and a credential you are
 * experimenting with should stay on your machine.
 *
 * Development-only. Not shipped, not referenced by the extension.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env['PORT'] ?? 8787);

/* Headers every browser sends, hidden by default so an injected header is
   obvious rather than buried in fifteen rows of noise. */
const ORDINARY = new Set([
  'host',
  'connection',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'upgrade-insecure-requests',
  'accept-encoding',
  'accept-language',
  'accept',
  'user-agent',
  'cache-control',
  'pragma',
  'priority',
]);

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Machine-readable, for scripting or curl.
  if (url.pathname === '/headers.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-echo-response': 'original' });
    res.end(JSON.stringify(req.headers, null, 2));
    return;
  }

  const entries = Object.entries(req.headers).sort(([a], [b]) => a.localeCompare(b));
  const injected = entries.filter(([name]) => !ORDINARY.has(name));
  const rest = entries.filter(([name]) => ORDINARY.has(name));

  const row = ([name, value]) =>
    `<tr><td><code>${escape(name)}</code></td><td><code>${escape(value)}</code></td></tr>`;

  /* The two tables are built here, on single lines, so the suppression below
     sits on exactly the expression it excuses rather than over a whole file.

     Semgrep flags these as user data flowing into manually-constructed HTML,
     and it is asking a fair question: the values are request headers, which is
     precisely the attacker-controllable input the rule exists for. Every cell
     goes through `escape`, which covers & < > " ' -- the rule cannot see
     through the helper. Verified rather than asserted: a request carrying
     `X-Probe: <script>alert(1)</script>` renders as escaped text, never as
     markup. */
  const none = '<p class="none">None — nothing has been injected on this request.</p>';
  const injectedTable = injected.length ? `<table>${injected.map(row).join('')}</table>` : none; // nosemgrep: javascript.express.security.injection.raw-html-format
  const restTable = `<table>${rest.map(row).join('')}</table>`; // nosemgrep: javascript.express.security.injection.raw-html-format

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // A response header to try removing or overwriting from the extension.
    'x-echo-response': 'original',
  });

  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Headsmith echo</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem;
         color: #14161a; background: #fff8f3; }
  @media (prefers-color-scheme: dark) { body { color: #f2ede8; background: #17140f; } }
  h1 { font-size: 1.2rem; } h2 { font-size: .95rem; margin-top: 1.8rem; }
  table { border-collapse: collapse; width: 100%; }
  td { border-bottom: 1px solid #8883; padding: .35rem .5rem; vertical-align: top; }
  td:first-child { width: 16rem; font-weight: 600; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
  .none { opacity: .6; font-style: italic; }
  .hint { opacity: .75; font-size: 13px; line-height: 1.5; }
  button { font: inherit; padding: .4rem .7rem; border-radius: 5px; border: 1px solid #8886;
           background: transparent; color: inherit; cursor: pointer; }
</style></head><body>
<h1>Headsmith echo</h1>
<p class="hint">Request headers this server received. Reload after changing a rule.
Remember Headsmith only applies a profile where its scope says — add
<code>localhost</code> as a domain, or leave the scope empty.</p>

<h2>Headers your browser does not normally send</h2>
${injectedTable}

<h2>Everything else</h2>
${restTable}

<h2>Response headers</h2>
<p class="hint">This page is served with <code>x-echo-response: original</code>.
Fetching it back shows what your browser saw after any response-header rules
were applied — try setting or removing that header in a profile.</p>
<button id="check">Fetch this page and show its response headers</button>
<div id="out"></div>

<script>
document.getElementById('check').addEventListener('click', async () => {
  const res = await fetch(location.pathname, { cache: 'no-store' });
  const rows = [...res.headers.entries()].sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => '<tr><td><code>' + k + '</code></td><td><code>' + v + '</code></td></tr>').join('');
  document.getElementById('out').innerHTML = '<table>' + rows + '</table>';
});
</script>
</body></html>`);
});

server.listen(PORT, () => {
  console.log(`\n  Headsmith echo server\n`);
  console.log(`    http://localhost:${PORT}            request + response headers`);
  console.log(`    http://localhost:${PORT}/headers.json   the same as JSON\n`);
  console.log(`  Ctrl-C to stop.\n`);
});
