import { describe, it, expect } from 'vitest';
import { checkDomain, checkDomains, repairDomains } from './domains';

/* Every "never matches" case below was verified against real Chrome, not
   inferred from the documentation: the rule was installed, a request was made,
   and the header did or did not arrive. Chrome accepts all of them without
   complaint, which is exactly why they need catching here. */

describe('domains Chrome accepts and then never matches', () => {
  const cases: [string, RegExp, string | undefined][] = [
    ['*.example.com', /wildcard/i, 'example.com'],
    ['*.a.b.example.com', /wildcard/i, 'a.b.example.com'],
    ['*', /never matches/i, undefined],
    ['*.*', /never matches/i, undefined],
    ['exam*ple.com', /wildcard/i, undefined],
    ['https://example.com', /scheme/i, 'example.com'],
    ['http://example.com', /scheme/i, 'example.com'],
    ['https://example.com/api', /scheme/i, 'example.com'],
    ['https://example.com:8080', /scheme/i, 'example.com'],
    ['.example.com', /leading dot/i, 'example.com'],
    ['example.com:8080', /port/i, 'example.com'],
    ['example.com/api/v2', /host only/i, 'example.com'],
  ];

  for (const [value, message, suggestion] of cases) {
    it(`flags "${value}"`, () => {
      const problem = checkDomain(value);
      expect(problem, `"${value}" should have been flagged`).not.toBeNull();
      expect(problem!.message).toMatch(message);
      expect(problem!.suggestion).toBe(suggestion);
    });
  }

  it('explains that a wildcard is unnecessary, not merely wrong', () => {
    // A plain domain already covers its subdomains -- verified in Chrome:
    // a rule naming `localhost` matched a request to `a.b.localhost`.
    expect(checkDomain('*.example.com')!.message).toMatch(/already covers its subdomains/i);
  });
});

describe('domains that are fine', () => {
  for (const value of [
    'example.com',
    'api.example.com',
    'a.b.c.example.com',
    'localhost',
    'EXAMPLE.com',
    'xn--80ak6aa92e.com',
    'example-with-hyphens.com',
    '127.0.0.1',
    'my-service',
  ]) {
    it(`accepts "${value}"`, () => {
      expect(checkDomain(value)).toBeNull();
    });
  }

  it('ignores whitespace-only entries rather than complaining about them', () => {
    expect(checkDomain('   ')).toBeNull();
    expect(checkDomain('')).toBeNull();
  });
});

describe('domains Chrome itself rejects', () => {
  it('flags non-ASCII, which is the one thing Chrome will not accept', () => {
    const problem = checkDomain('exämple.com');
    expect(problem!.message).toMatch(/non-ascii|punycode/i);
  });
});

describe('malformed hostnames', () => {
  for (const value of ['exa mple.com', 'exa_mple.com', '-example.com', 'example-.com', 'a..b.com']) {
    it(`flags "${value}"`, () => {
      expect(checkDomain(value)).not.toBeNull();
    });
  }
});

describe('checkDomains', () => {
  it('reports only the problematic entries', () => {
    const problems = checkDomains(['good.example.com', '*.bad.example.com', 'also-good.com']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.value).toBe('*.bad.example.com');
  });

  it('is empty for a clean list', () => {
    expect(checkDomains(['a.example.com', 'b.example.com'])).toEqual([]);
  });
});

describe('repairDomains', () => {
  it('applies every unambiguous suggestion', () => {
    expect(
      repairDomains(['*.example.com', 'https://api.example.com', 'plain.example.com']),
    ).toEqual(['example.com', 'api.example.com', 'plain.example.com']);
  });

  it('leaves entries it cannot confidently rewrite', () => {
    // A bare star has no obvious replacement -- "everywhere" is expressed by
    // an empty list, and silently emptying the field would be worse.
    expect(repairDomains(['*', 'good.com'])).toEqual(['*', 'good.com']);
  });

  it('deduplicates when two entries repair to the same host', () => {
    expect(repairDomains(['*.example.com', 'https://example.com', 'example.com'])).toEqual([
      'example.com',
    ]);
  });

  it('is idempotent', () => {
    const once = repairDomains(['*.example.com', 'example.com:8080']);
    expect(repairDomains(once)).toEqual(once);
  });

  it('leaves a clean list untouched', () => {
    const clean = ['a.example.com', 'b.example.com'];
    expect(repairDomains(clean)).toEqual(clean);
  });
});
