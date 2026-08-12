import { describe, it, expect } from 'vitest';
import {
  ALL_URLS,
  originForDomain,
  originsForMatch,
  originsForProfile,
  originsForConfig,
  isCovered,
  permissionGaps,
  describeOrigin,
} from './origins';
import { blankHeaderOp, blankProfile, parseConfig, type MatchSet, type Profile } from './schema';

function match(patch: Partial<MatchSet['include']> = {}): MatchSet {
  return {
    include: { domains: [], urlContains: [], urlRegex: [], ...patch },
    exclude: { domains: [] },
    resourceTypes: [],
  };
}

function profile(patch: Partial<Profile> = {}): Profile {
  return {
    ...blankProfile(1),
    requestHeaders: [blankHeaderOp({ name: 'X-Env', value: 'staging' })],
    responseHeaders: [],
    ...patch,
  };
}

describe('originForDomain', () => {
  it('produces a pattern covering the domain and its subdomains', () => {
    /* Chrome's `*.example.com` matches example.com itself as well as anything
       below it -- exactly what requestDomains matches, so the permission is
       neither wider nor narrower than the rule it serves. */
    expect(originForDomain('example.com')).toBe('*://*.example.com/*');
  });

  it('normalises case and whitespace', () => {
    expect(originForDomain('  Example.COM ')).toBe('*://*.example.com/*');
  });
});

describe('originsForMatch', () => {
  it('asks only for the named domains', () => {
    expect(originsForMatch(match({ domains: ['a.example.com', 'b.example.com'] }))).toEqual({
      origins: ['*://*.a.example.com/*', '*://*.b.example.com/*'],
      needsAllUrls: false,
    });
  });

  it('still asks only for the domains when URL filters are also present', () => {
    /* A compiled condition ANDs requestDomains with the URL term, so no
       request outside those domains can match however the URL filter is
       written. Granting the domains is therefore sufficient. */
    const need = originsForMatch(
      match({ domains: ['api.example.com'], urlContains: ['/v2'], urlRegex: ['^https://'] }),
    );
    expect(need.needsAllUrls).toBe(false);
    expect(need.origins).toEqual(['*://*.api.example.com/*']);
  });

  it('needs everything when scoped only by URL text', () => {
    // A substring can appear in a URL on any host, so nothing narrower will do.
    expect(originsForMatch(match({ urlContains: ['/api/v2'] }))).toEqual({
      origins: [ALL_URLS],
      needsAllUrls: true,
    });
  });

  it('needs everything when scoped only by regex', () => {
    expect(originsForMatch(match({ urlRegex: ['^https://[a-z]+\\.example\\.com/'] })).needsAllUrls).toBe(
      true,
    );
  });

  it('needs everything when not scoped at all', () => {
    expect(originsForMatch(match()).needsAllUrls).toBe(true);
  });

  it('deduplicates repeated domains', () => {
    expect(originsForMatch(match({ domains: ['a.com', 'a.com'] })).origins).toEqual([
      '*://*.a.com/*',
    ]);
  });
});

describe('originsForProfile', () => {
  it('asks for nothing when the profile would emit no rules', () => {
    // Nobody should be prompted for a profile they have not filled in yet.
    expect(originsForProfile(profile({ requestHeaders: [] })).origins).toEqual([]);
  });

  it('asks for nothing when the profile is disabled', () => {
    expect(originsForProfile(profile({ enabled: false })).origins).toEqual([]);
  });

  it('ignores headers that are disabled or unnamed', () => {
    expect(
      originsForProfile(
        profile({
          requestHeaders: [
            blankHeaderOp({ name: 'X-Off', value: '1', enabled: false }),
            blankHeaderOp({ name: '', value: '2' }),
          ],
        }),
      ).origins,
    ).toEqual([]);
  });

  it('asks once the profile has something to do', () => {
    expect(
      originsForProfile(profile({ match: match({ domains: ['x.example.com'] }) })).origins,
    ).toEqual(['*://*.x.example.com/*']);
  });
});

describe('originsForConfig', () => {
  it('collects the domains of every profile', () => {
    const config = parseConfig({
      ...parseConfig({}),
      profiles: [
        profile({ id: 'p1', match: match({ domains: ['a.com'] }) }),
        profile({ id: 'p2', match: match({ domains: ['b.com'] }) }),
      ],
    });
    expect([...originsForConfig(config).origins].sort()).toEqual([
      '*://*.a.com/*',
      '*://*.b.com/*',
    ]);
  });

  it('collapses to broad access when any profile needs it', () => {
    /* Asking for both would show a longer prompt describing no additional
       access, since broad access already subsumes the specific ones. */
    const config = parseConfig({
      ...parseConfig({}),
      profiles: [
        profile({ id: 'p1', match: match({ domains: ['a.com'] }) }),
        profile({ id: 'p2', match: match({ urlContains: ['/api'] }) }),
      ],
    });
    expect(originsForConfig(config)).toEqual({ origins: [ALL_URLS], needsAllUrls: true });
  });

  it('asks for nothing when no profile is configured to do anything', () => {
    const config = parseConfig({
      ...parseConfig({}),
      profiles: [profile({ id: 'p1', requestHeaders: [] })],
    });
    expect(originsForConfig(config).origins).toEqual([]);
  });
});

describe('isCovered', () => {
  it('accepts an exact grant', () => {
    expect(isCovered({ origins: ['*://*.a.com/*'], needsAllUrls: false }, ['*://*.a.com/*'])).toBe(
      true,
    );
  });

  it('accepts broad access for anything', () => {
    expect(isCovered({ origins: ['*://*.a.com/*'], needsAllUrls: false }, [ALL_URLS])).toBe(true);
    expect(isCovered({ origins: [ALL_URLS], needsAllUrls: true }, ['<all_urls>'])).toBe(true);
  });

  it('rejects a partial grant', () => {
    expect(
      isCovered({ origins: ['*://*.a.com/*', '*://*.b.com/*'], needsAllUrls: false }, [
        '*://*.a.com/*',
      ]),
    ).toBe(false);
  });

  it('treats needing nothing as covered', () => {
    expect(isCovered({ origins: [], needsAllUrls: false }, [])).toBe(true);
  });
});

describe('permissionGaps', () => {
  const configWith = (profiles: Profile[]) =>
    parseConfig({ ...parseConfig({}), profiles, activeProfileId: profiles[0]?.id });

  it('reports a profile whose hosts are not granted', () => {
    const config = configWith([
      profile({ id: 'p1', name: 'API', match: match({ domains: ['api.example.com'] }) }),
    ]);
    const gaps = permissionGaps(config, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      profileName: 'API',
      origins: ['*://*.api.example.com/*'],
      needsAllUrls: false,
    });
  });

  it('reports nothing once the hosts are granted', () => {
    const config = configWith([
      profile({ id: 'p1', match: match({ domains: ['api.example.com'] }) }),
    ]);
    expect(permissionGaps(config, ['*://*.api.example.com/*'])).toEqual([]);
  });

  it('flags a credential profile distinctly, since it fails twice over', () => {
    const config = configWith([
      profile({
        id: 'p1',
        name: 'Token',
        match: match({ domains: ['api.example.com'] }),
        requestHeaders: [blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })],
      }),
    ]);
    expect(permissionGaps(config, [])[0]!.hasCredential).toBe(true);
  });

  it('says nothing about a profile that would emit no rules', () => {
    const config = configWith([profile({ id: 'p1', requestHeaders: [] })]);
    expect(permissionGaps(config, [])).toEqual([]);
  });
});

describe('describeOrigin', () => {
  it('turns a pattern back into something a person recognises', () => {
    expect(describeOrigin('*://*.api.example.com/*')).toBe('api.example.com');
    expect(describeOrigin(ALL_URLS)).toBe('every site');
    expect(describeOrigin('<all_urls>')).toBe('every site');
  });

  it('passes anything unrecognised through unchanged', () => {
    expect(describeOrigin('weird')).toBe('weird');
  });
});
