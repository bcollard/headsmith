/* Tests for the guard scanner.
 *
 * The egress guard's whole judgement rests on telling code from comments from
 * string literals: a `fetch(` inside a comment must not fail the build, and a
 * `fetch(` in real code must. Since that distinction is drawn by a hand-rolled
 * tokenizer rather than a parser, it is the tokenizer that needs the tests --
 * a guard nobody has tested is a guard nobody should believe.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain ESM, deliberately outside the TypeScript project
import { scanJs, externalOrigins } from '../../scripts/lib/scan.mjs';

describe('scanJs', () => {
  it('strips line comments so a mention is not a use', () => {
    const { code } = scanJs('// we never call fetch( here\nconst x = 1;');
    expect(code).not.toContain('fetch(');
    expect(code).toContain('const x = 1;');
  });

  it('strips block comments, including multi-line ones', () => {
    const { code } = scanJs('/* fetch(url)\n   new WebSocket(x) */\nconst y = 2;');
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('WebSocket');
  });

  it('keeps a real call in the code stream', () => {
    const { code } = scanJs('async function go(){ await fetch(u); }');
    expect(code).toContain('fetch(');
  });

  it('collects string literal contents and removes them from code', () => {
    const { code, strings } = scanJs('const u = "https://evil.example/beacon";');
    expect(strings).toContain('https://evil.example/beacon');
    expect(code).not.toContain('evil.example');
  });

  it('handles all three quote styles', () => {
    const { strings } = scanJs(`const a = 'one'; const b = "two"; const c = \`three\`;`);
    expect(strings).toEqual(['one', 'two', 'three']);
  });

  it('does not end a string at an escaped quote', () => {
    const { strings } = scanJs('const s = "he said \\"fetch(\\" loudly";');
    expect(strings).toEqual(['he said "fetch(" loudly']);
  });

  it('does not treat a quote inside a comment as opening a string', () => {
    // If the scanner mishandled this, everything after it would be swallowed
    // as string content and the real fetch( below would go unseen.
    const { code } = scanJs("// don't do this\nfetch(u);");
    expect(code).toContain('fetch(');
  });

  it('skips regex literals so their contents are not read as code', () => {
    const { code } = scanJs('const re = /fetch\\(/; const n = 1;');
    expect(code).not.toContain('fetch(');
    expect(code).toContain('const n = 1;');
  });

  it('treats a slash after an identifier as division, not a regex', () => {
    // `a / b` followed later by a real call: if `/` were read as opening a
    // regex, the rest of the line would be consumed and the call lost.
    const { code } = scanJs('const r = a / b; fetch(u);');
    expect(code).toContain('fetch(');
  });

  it('does not lose code after a template literal', () => {
    const { code } = scanJs('const t = `hello`; fetch(u);');
    expect(code).toContain('fetch(');
  });

  it('sees through the shape of Vite\'s modulepreload polyfill', () => {
    // The real bundle case: "modulepreload" appears only inside string
    // literals, so a context pattern matching on it would never fire against
    // stripped code. Recorded here because that mistake was made once.
    const source = `
      const relList = document.createElement("link").relList;
      if (relList.supports("modulepreload")) return;
      function processPreload(link) { fetch(link.href); }
    `;
    const { code, strings } = scanJs(source);
    expect(strings).toContain('modulepreload');
    expect(code).not.toContain('modulepreload');
    expect(code).toContain('processPreload');
    expect(code).toContain('fetch(');
  });
});

describe('externalOrigins', () => {
  it('extracts hosts from http and https URLs', () => {
    expect(externalOrigins('see https://a.example/x and http://b.example/y')).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('keeps the port when one is present', () => {
    expect(externalOrigins('http://localhost:9876/health')).toEqual(['localhost:9876']);
  });

  it('deduplicates repeated hosts', () => {
    expect(externalOrigins('https://x.example/1 https://x.example/2')).toEqual(['x.example']);
  });

  it('finds nothing in a relative path', () => {
    expect(externalOrigins('./chunks/app-abc123.js')).toEqual([]);
  });
});
