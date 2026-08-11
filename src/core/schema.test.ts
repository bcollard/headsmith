import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  defaultConfig,
  blankProfile,
  blankHeaderOp,
  collectSecretIds,
  secretRefCount,
  headerOpSchema,
  SCHEMA_VERSION,
} from './schema';

describe('parseConfig never throws', () => {
  // Configuration arrives from storage written by an older build, from an
  // imported file, or from someone editing JSON. Every one of these used to be
  // a way to lose a profile list.
  const hostile: unknown[] = [
    undefined,
    null,
    0,
    '',
    'not a config',
    [],
    {},
    { profiles: 'nope' },
    { profiles: [null, undefined, 42] },
    { profiles: [{ requestHeaders: 'no' }] },
    { version: 999 },
    { settings: { credentialStorage: 'plaintext' } },
    { settings: null },
    { exclusions: { urlRegex: [1, 2, 3] } },
    { secretsMeta: 'nope' },
    { profiles: [{ match: { include: { domains: 5 } } }] },
  ];

  for (const [i, input] of hostile.entries()) {
    it(`survives hostile input #${i}: ${JSON.stringify(input)?.slice(0, 50)}`, () => {
      const config = parseConfig(input);
      expect(config.version).toBe(SCHEMA_VERSION);
      expect(config.profiles.length).toBeGreaterThan(0);
      expect(config.profiles.some((p) => p.id === config.activeProfileId)).toBe(true);
    });
  }

  it('falls back to a safe credential mode when given an unknown one', () => {
    // "plaintext" was a real mode in OpenModHeader. An imported config naming
    // it must not silently become a request to store secrets on disk.
    const config = parseConfig({ settings: { credentialStorage: 'plaintext' } });
    expect(config.settings.credentialStorage).toBe('session');
  });
});

describe('credential values never survive parsing', () => {
  it('strips an inline value from a header that references a secret', () => {
    const header = headerOpSchema.parse({
      id: 'h1',
      enabled: true,
      operation: 'set',
      name: 'Authorization',
      value: 'Bearer super-secret-token',
      comment: '',
      sensitive: true,
      secretId: 'secret-abc',
    });
    expect(header.value).toBe('');
    expect(header.secretId).toBe('secret-abc');
  });

  it('strips it through a whole config parse too', () => {
    const config = parseConfig({
      profiles: [
        {
          id: 'p1',
          name: 'API',
          requestHeaders: [
            { id: 'h1', name: 'Authorization', value: 'Bearer leak-me', secretId: 'secret-1' },
          ],
        },
      ],
    });
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain('leak-me');
  });

  it('keeps the value of an ordinary header', () => {
    const header = headerOpSchema.parse({
      id: 'h1',
      name: 'X-Debug',
      value: 'on',
      secretId: null,
    });
    expect(header.value).toBe('on');
  });
});

describe('cross-field repair', () => {
  it('replaces an activeProfileId that names nothing', () => {
    const config = parseConfig({
      activeProfileId: 'ghost',
      profiles: [{ id: 'real', name: 'Real' }],
    });
    expect(config.activeProfileId).toBe('real');
  });

  it('gives duplicate profile ids fresh ones', () => {
    const config = parseConfig({
      profiles: [
        { id: 'same', name: 'One' },
        { id: 'same', name: 'Two' },
      ],
    });
    const ids = config.profiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('drops metadata for secrets nothing references', () => {
    const config = parseConfig({
      profiles: [{ id: 'p1', name: 'P', requestHeaders: [] }],
      secretsMeta: { 'secret-orphan': { label: 'stale', createdAt: 1 } },
    });
    expect(config.secretsMeta['secret-orphan']).toBeUndefined();
  });

  it('backfills metadata for a referenced secret that has none', () => {
    const config = parseConfig({
      profiles: [
        {
          id: 'p1',
          name: 'P',
          requestHeaders: [{ id: 'h', name: 'Authorization', secretId: 'secret-1' }],
        },
      ],
      secretsMeta: {},
    });
    expect(config.secretsMeta['secret-1']).toBeDefined();
  });
});

describe('normalisation of individual fields', () => {
  it('discards non-string entries from a domain list', () => {
    const config = parseConfig({
      profiles: [
        { id: 'p', name: 'P', match: { include: { domains: ['ok.example', 42, null, ' spaced '] } } },
      ],
    });
    expect(config.profiles[0]!.match.include.domains).toEqual(['ok.example', 'spaced']);
  });

  it('deduplicates resource types', () => {
    const config = parseConfig({
      profiles: [{ id: 'p', name: 'P', match: { resourceTypes: ['script', 'script', 'image'] } }],
    });
    expect(config.profiles[0]!.match.resourceTypes).toEqual(['script', 'image']);
  });

  it('drops a resource type Chrome would reject', () => {
    // Chrome rejects the whole rule on an unknown resource type, so an
    // imported Firefox profile naming `beacon` must not poison the rule.
    const config = parseConfig({
      profiles: [{ id: 'p', name: 'P', match: { resourceTypes: ['script', 'beacon'] } }],
    });
    expect(config.profiles[0]!.match.resourceTypes).not.toContain('beacon');
  });

  it('clamps an out-of-range auto-lock interval', () => {
    expect(parseConfig({ settings: { lockAfterMinutes: 0 } }).settings.lockAfterMinutes).toBe(15);
    expect(parseConfig({ settings: { lockAfterMinutes: 99999 } }).settings.lockAfterMinutes).toBe(15);
    expect(parseConfig({ settings: { lockAfterMinutes: 60 } }).settings.lockAfterMinutes).toBe(60);
  });
});

describe('secret references', () => {
  const config = {
    profiles: [
      {
        ...blankProfile(1),
        requestHeaders: [
          blankHeaderOp({ name: 'Authorization', secretId: 'secret-shared' }),
          blankHeaderOp({ name: 'X-Api-Key', secretId: 'secret-only' }),
        ],
        responseHeaders: [],
      },
      {
        ...blankProfile(2),
        requestHeaders: [blankHeaderOp({ name: 'Authorization', secretId: 'secret-shared' })],
        responseHeaders: [],
      },
    ],
  };

  it('collects every referenced id once', () => {
    expect(collectSecretIds(config).sort()).toEqual(['secret-only', 'secret-shared']);
  });

  it('counts references so a shared secret survives one profile being deleted', () => {
    expect(secretRefCount(config, 'secret-shared')).toBe(2);
    expect(secretRefCount(config, 'secret-only')).toBe(1);
    expect(secretRefCount(config, 'secret-absent')).toBe(0);
  });
});

describe('defaultConfig', () => {
  it('is valid according to its own parser, unchanged', () => {
    const fresh = defaultConfig();
    expect(parseConfig(fresh)).toEqual(fresh);
  });

  it('round-trips through JSON, which is how it reaches storage', () => {
    const fresh = defaultConfig();
    expect(parseConfig(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
  });
});
