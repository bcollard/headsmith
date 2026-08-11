import { describe, it, expect } from 'vitest';
import { compile, conditionsFor, forChrome, PRIORITY } from './compile';
import { budgetFor, LIMITS, measure } from './budget';
import { parseConfig, blankProfile, blankHeaderOp, type Config, type Profile } from './schema';
import {
  compareWithFixture,
  expectValueAbsent,
  expectValueOnlyIn,
  headerEntries,
  ruleCount,
} from '../../test/fixtures/harness';

function configWith(profiles: Profile[], overrides: Partial<Config> = {}): Config {
  return parseConfig({
    ...parseConfig({}),
    profiles,
    activeProfileId: profiles[0]?.id,
    ...overrides,
  });
}

function profile(name: string, patch: Partial<Profile> = {}): Profile {
  return { ...blankProfile(1), name, requestHeaders: [], responseHeaders: [], ...patch };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe('conditionsFor', () => {
  it('produces one bare condition when nothing narrows the match', () => {
    const conditions = conditionsFor(blankProfile(1).match);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({ resourceTypes: expect.arrayContaining(['main_frame']) });
  });

  it('does not spend a regex slot on "match everything"', () => {
    // FlexHeader's catch-all is `regexFilter: "|http*"`, which consumes one of
    // the 1,000 regex slots per header to say what an empty condition says for
    // free. This is the assertion that keeps us from drifting into that.
    const conditions = conditionsFor(blankProfile(1).match);
    expect(conditions[0]).not.toHaveProperty('regexFilter');
    expect(conditions[0]).not.toHaveProperty('urlFilter');
  });

  it('folds domains into every condition rather than emitting rules for them', () => {
    const conditions = conditionsFor({
      include: { domains: ['api.example.com'], urlContains: ['/v1', '/v2'], urlRegex: [] },
      exclude: { domains: ['cdn.example.com'] },
      resourceTypes: [],
    });
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition['requestDomains']).toEqual(['api.example.com']);
      expect(condition['excludedRequestDomains']).toEqual(['cdn.example.com']);
    }
  });

  it('gives each url term its own condition, since DNR takes one per rule', () => {
    const conditions = conditionsFor({
      include: { domains: [], urlContains: ['/a'], urlRegex: ['^https://x\\.test/'] },
      exclude: { domains: [] },
      resourceTypes: ['xmlhttprequest'],
    });
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toMatchObject({ urlFilter: '/a', resourceTypes: ['xmlhttprequest'] });
    expect(conditions[1]).toMatchObject({ regexFilter: '^https://x\\.test/' });
  });
});

// ---------------------------------------------------------------------------
// Bucketing -- the property that decides whether realistic configs fit
// ---------------------------------------------------------------------------

describe('condition bucketing', () => {
  it('emits one rule per condition, not one per header per condition', () => {
    const headers = Array.from({ length: 12 }, (_, i) =>
      blankHeaderOp({ name: `X-Custom-${i}`, value: String(i) }),
    );
    const config = configWith([
      profile('Many', {
        requestHeaders: headers,
        match: {
          include: {
            domains: [],
            urlContains: ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'],
            urlRegex: [],
          },
          exclude: { domains: [] },
          resourceTypes: [],
        },
      }),
    ]);

    const result = compile(config);

    // FlexHeader would emit 12 x 8 = 96 here.
    expect(result.dynamic).toHaveLength(8);
    for (const rule of result.dynamic) {
      expect(rule.action.requestHeaders).toHaveLength(12);
    }
  });

  it('keeps request and response headers in the same rule', () => {
    const config = configWith([
      profile('Both', {
        requestHeaders: [blankHeaderOp({ name: 'X-Req', value: '1' })],
        responseHeaders: [blankHeaderOp({ name: 'X-Res', value: '2' })],
      }),
    ]);
    const result = compile(config);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]!.action.requestHeaders).toHaveLength(1);
    expect(result.dynamic[0]!.action.responseHeaders).toHaveLength(1);
  });

  it('emits nothing for a disabled profile', () => {
    const config = configWith([
      profile('Off', { enabled: false, requestHeaders: [blankHeaderOp({ name: 'X', value: '1' })] }),
    ]);
    expect(compile(config).dynamic).toHaveLength(0);
  });

  it('emits nothing at all when paused', () => {
    const config = configWith(
      [profile('On', { requestHeaders: [blankHeaderOp({ name: 'X', value: '1' })] })],
      { paused: true },
    );
    const result = compile(config);
    expect(result.dynamic).toHaveLength(0);
    expect(result.session).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credential routing -- the security-critical split
// ---------------------------------------------------------------------------

describe('credential routing', () => {
  const secretProfile = profile('API', {
    match: {
      include: { domains: ['api.example.com'], urlContains: [], urlRegex: [] },
      exclude: { domains: [] },
      resourceTypes: [],
    },
    requestHeaders: [
      blankHeaderOp({ name: 'Authorization', secretId: 'secret-1', sensitive: true }),
      blankHeaderOp({ name: 'X-Debug', value: 'on' }),
    ],
  });

  const resolve = (id: string) => (id === 'secret-1' ? 'Bearer live-token-value' : null);
  const resolvedIds = new Set(['secret-1']);

  it('sends a credential to the session bucket and never the dynamic one', () => {
    // Dynamic rules are persisted to disk by Chrome. Session rules are not.
    // This is the assertion that keeps a token off disk.
    const result = compile(configWith([secretProfile]), { resolve, resolvedIds });

    expect(JSON.stringify(forChrome(result.dynamic))).not.toContain('live-token-value');
    expect(JSON.stringify(forChrome(result.session))).toContain('live-token-value');
  });

  it('still applies the profile\'s ordinary headers alongside', () => {
    const result = compile(configWith([secretProfile]), { resolve, resolvedIds });
    expect(JSON.stringify(forChrome(result.dynamic))).toContain('x-debug');
  });

  it('withholds the credential but keeps the rest when the vault is locked', () => {
    const config = configWith([secretProfile], {
      settings: { ...parseConfig({}).settings, credentialStorage: 'vault' },
    });
    const result = compile(config, { resolve, resolvedIds, unlocked: false });

    expect(result.session).toHaveLength(0);
    expect(JSON.stringify(result.dynamic)).toContain('x-debug');
    expect(result.blocked[0]!.verdict.reasons).toContain('vault-locked');
  });

  it('never substitutes an empty value for an unresolvable secret', () => {
    // The fail-closed rule. An `Authorization:` header with nothing after it
    // is worse than no header: it reads as a failed auth attempt.
    const result = compile(configWith([secretProfile]), {
      resolve: () => null,
      resolvedIds: new Set(),
    });

    const entries = [...result.session, ...result.dynamic].flatMap((r) => [
      ...(r.action.requestHeaders ?? []),
      ...(r.action.responseHeaders ?? []),
    ]);
    expect(entries.some((e) => e.header === 'authorization')).toBe(false);
    expect(result.blocked[0]!.verdict.reasons).toContain('missing-credential');
  });

  it('drops a sensitive header that has no secret reference at all', () => {
    // Arises from a hand-edited config or a half-finished import. Its inline
    // value must not be sent.
    const config = configWith([
      profile('Hand-edited', {
        match: {
          include: { domains: ['api.example.com'], urlContains: [], urlRegex: [] },
          exclude: { domains: [] },
          resourceTypes: [],
        },
        requestHeaders: [
          { ...blankHeaderOp({ name: 'Authorization' }), value: 'Bearer smuggled', secretId: null },
        ],
      }),
    ]);
    const result = compile(config, { resolve, resolvedIds });

    expect(JSON.stringify(result)).not.toContain('smuggled');
    expect(result.blocked[0]!.verdict.unmanagedHeaders).toContain('Authorization');
  });

  it('does not treat removing a credential header as handling a credential', () => {
    // Removing `Authorization` involves no secret and should not demand an
    // unlocked vault or a host restriction.
    const config = configWith([
      profile('Strip', {
        requestHeaders: [blankHeaderOp({ name: 'Authorization', operation: 'remove' })],
      }),
    ]);
    const result = compile(config, { resolve: () => null, resolvedIds: new Set() });

    expect(result.blocked).toHaveLength(0);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]!.action.requestHeaders![0]).toEqual({
      header: 'authorization',
      operation: 'remove',
    });
  });

  it('blocks a credential profile that names no host', () => {
    const config = configWith([
      profile('Global token', {
        requestHeaders: [
          blankHeaderOp({ name: 'Authorization', secretId: 'secret-1', sensitive: true }),
        ],
      }),
    ]);
    const result = compile(config, { resolve, resolvedIds });

    expect(result.session).toHaveLength(0);
    expect(result.blocked[0]!.verdict.reasons).toContain('no-host-restriction');
  });
});

// ---------------------------------------------------------------------------
// Rules Chrome would reject
// ---------------------------------------------------------------------------

describe('invalid operations are dropped before Chrome sees them', () => {
  it('drops an append on a request header Chrome does not allow it for', () => {
    // One bad rule makes DNR reject the whole batch, so a typo here would take
    // every other rule in the profile down with it.
    const config = configWith([
      profile('Bad append', {
        requestHeaders: [
          blankHeaderOp({ name: 'X-Not-Appendable', value: 'v', operation: 'append' }),
          blankHeaderOp({ name: 'Accept', value: 'text/plain', operation: 'append' }),
        ],
      }),
    ]);
    const result = compile(config);

    const headers = result.dynamic.flatMap((r) => r.action.requestHeaders ?? []);
    expect(headers.map((h) => h.header)).toEqual(['accept']);
    expect(result.problems[0]).toMatchObject({ detail: 'append-not-allowed' });
  });

  it('allows append on any response header', () => {
    const config = configWith([
      profile('Response append', {
        responseHeaders: [blankHeaderOp({ name: 'X-Anything', value: 'v', operation: 'append' })],
      }),
    ]);
    expect(compile(config).problems).toHaveLength(0);
  });

  it('drops a header whose name is not a valid token', () => {
    const config = configWith([
      profile('Bad name', {
        requestHeaders: [blankHeaderOp({ name: 'X Bad Header', value: 'v' })],
      }),
    ]);
    const result = compile(config);
    expect(result.dynamic).toHaveLength(0);
    expect(result.problems[0]).toMatchObject({ detail: 'invalid-name' });
  });

  it('lowercases header names, as Chrome requires', () => {
    const config = configWith([
      profile('Case', { requestHeaders: [blankHeaderOp({ name: 'X-Mixed-Case', value: 'v' })] }),
    ]);
    expect(compile(config).dynamic[0]!.action.requestHeaders![0]!.header).toBe('x-mixed-case');
  });

  it('omits the value on a remove, which Chrome rejects if present', () => {
    const config = configWith([
      profile('Remove', {
        requestHeaders: [blankHeaderOp({ name: 'X-Gone', value: 'ignored', operation: 'remove' })],
      }),
    ]);
    expect(compile(config).dynamic[0]!.action.requestHeaders![0]).not.toHaveProperty('value');
  });
});

// ---------------------------------------------------------------------------
// Global exclusions
// ---------------------------------------------------------------------------

describe('global exclusions', () => {
  it('compiles to allow rules that outrank every modify rule', () => {
    const config = configWith(
      [profile('P', { requestHeaders: [blankHeaderOp({ name: 'X-A', value: '1' })] })],
      { exclusions: { urlContains: ['/healthz'], urlRegex: ['\\.(png|jpe?g)$'] } },
    );
    const result = compile(config);

    const allows = result.dynamic.filter((r) => r.action.type === 'allow');
    expect(allows).toHaveLength(2);
    for (const rule of allows) {
      expect(rule.priority).toBe(PRIORITY.allow);
      expect(rule.priority).toBeGreaterThan(PRIORITY.modifyHeaders);
    }
  });

  it('counts as a safe action, so it does not consume the unsafe budget', () => {
    const config = configWith([profile('P', {})], {
      exclusions: { urlContains: ['/a', '/b'], urlRegex: [] },
    });
    const usage = measure(compile(config).dynamic);
    expect(usage.total).toBe(2);
    expect(usage.unsafe).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('rule budget', () => {
  it('keeps a large realistic profile far under the ceiling', () => {
    // The scenario the kickoff asks about: someone with a lot of services and
    // a lot of headers. 20 profiles x 10 headers x 6 URL filters. FlexHeader's
    // one-rule-per-header-per-filter model would emit 20 x 10 x 6 = 1,200
    // rules for this; bucketing gives 20 x 6 = 120.
    const profiles = Array.from({ length: 20 }, (_, p) =>
      profile(`Service ${p}`, {
        id: `p${p}`,
        match: {
          include: {
            domains: [`svc${p}.example.com`],
            urlContains: ['/v1', '/v2', '/v3', '/graphql', '/health', '/metrics'],
            urlRegex: [],
          },
          exclude: { domains: [] },
          resourceTypes: [],
        },
        requestHeaders: Array.from({ length: 10 }, (_, h) =>
          blankHeaderOp({ id: `p${p}h${h}`, name: `X-Svc-${h}`, value: `v${h}` }),
        ),
      }),
    );

    const result = compile(configWith(profiles));
    const budget = budgetFor(result);

    expect(result.dynamic).toHaveLength(120);
    expect(budget.overBudget).toBe(false);
    // "Well under budget" made concrete: under 5% of the binding ceiling.
    expect(budget.dynamic.unsafe).toBeLessThan(LIMITS.unsafeDynamic * 0.05);
    expect(budget.pressure).toBeLessThan(0.05);
  });

  it('counts regex rules against their own, much tighter ceiling', () => {
    // 1,000 regex rules per set versus 5,000 unsafe -- five times scarcer, and
    // the limit neither reference project accounts for.
    const config = configWith([
      profile('Regexy', {
        match: {
          include: {
            domains: [],
            urlContains: [],
            urlRegex: Array.from({ length: 40 }, (_, i) => `^https://a${i}\\.example\\.com/`),
          },
          exclude: { domains: [] },
          resourceTypes: [],
        },
        requestHeaders: [blankHeaderOp({ name: 'X-A', value: '1' })],
      }),
    ]);
    const budget = budgetFor(compile(config));

    expect(budget.dynamic.regex).toBe(40);
    expect(budget.dynamic.unsafe).toBe(40);
    // Same rule count, but four times the pressure, because regex is scarcer.
    expect(budget.pressure).toBeCloseTo(40 / LIMITS.regexPerRuleSet, 5);
  });

  it('reports a breach rather than silently emitting an over-budget set', () => {
    const fake = {
      dynamic: Array.from({ length: LIMITS.unsafeDynamic + 1 }, (_, i) => ({
        id: i + 1,
        priority: 1,
        action: { type: 'modifyHeaders' as const },
        condition: {},
      })),
      session: [],
    };
    const budget = budgetFor(fake);
    expect(budget.overBudget).toBe(true);
    expect(budget.breaches[0]).toContain('unsafe dynamic rules');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('compiled rule fixtures', () => {
  it('domains-only match', () => {
    const config = configWith([
      profile('Domains', {
        id: 'fix-domains',
        match: {
          include: { domains: ['api.example.com', 'api2.example.com'], urlContains: [], urlRegex: [] },
          exclude: { domains: ['cdn.example.com'] },
          resourceTypes: [],
        },
        requestHeaders: [
          blankHeaderOp({ id: 'h1', name: 'X-Env', value: 'staging' }),
          blankHeaderOp({ id: 'h2', name: 'X-Trace', value: 'on' }),
        ],
      }),
    ]);
    const snapshot = compareWithFixture(compile(config), 'domains-only');
    expect(ruleCount(snapshot)).toBe(1);
    expect(headerEntries(snapshot, 'dynamic').map((e) => e.header)).toEqual(['x-env', 'x-trace']);
  });

  it('mixed url filters and resource types', () => {
    const config = configWith([
      profile('Mixed', {
        id: 'fix-mixed',
        match: {
          include: {
            domains: ['example.com'],
            urlContains: ['/api/v1'],
            urlRegex: ['^https://example\\.com/graphql'],
          },
          exclude: { domains: [] },
          resourceTypes: ['xmlhttprequest', 'main_frame'],
        },
        requestHeaders: [blankHeaderOp({ id: 'h1', name: 'X-Api-Version', value: '2024-01' })],
        responseHeaders: [
          blankHeaderOp({ id: 'h2', name: 'Access-Control-Allow-Origin', value: '*' }),
        ],
      }),
    ]);
    const snapshot = compareWithFixture(compile(config), 'mixed-filters');
    expect(ruleCount(snapshot)).toBe(2);
  });

  it('credential split across buckets', () => {
    const config = configWith([
      profile('Credential', {
        id: 'fix-cred',
        match: {
          include: { domains: ['api.example.com'], urlContains: [], urlRegex: [] },
          exclude: { domains: [] },
          resourceTypes: [],
        },
        requestHeaders: [
          blankHeaderOp({ id: 'h1', name: 'Authorization', secretId: 'secret-1', sensitive: true }),
          blankHeaderOp({ id: 'h2', name: 'X-Debug', value: 'on' }),
        ],
      }),
    ]);
    const snapshot = compareWithFixture(
      compile(config, { resolve: () => 'Bearer FIXTURE-TOKEN', resolvedIds: new Set(['secret-1']) }),
      'credential-split',
    );

    expectValueOnlyIn(snapshot, 'Bearer FIXTURE-TOKEN', 'session');
    expectValueOnlyIn(snapshot, 'x-debug', 'dynamic');
  });

  it('blocked credential profile', () => {
    const config = configWith([
      profile('Blocked', {
        id: 'fix-blocked',
        requestHeaders: [
          blankHeaderOp({ id: 'h1', name: 'Authorization', secretId: 'secret-1', sensitive: true }),
          blankHeaderOp({ id: 'h2', name: 'X-Safe', value: 'yes' }),
        ],
      }),
    ]);
    const snapshot = compareWithFixture(
      compile(config, { resolve: () => 'Bearer NEVER-EMIT', resolvedIds: new Set(['secret-1']) }),
      'blocked-no-host',
    );

    expectValueAbsent(snapshot, 'Bearer NEVER-EMIT');
    expect(snapshot.blocked[0]!.reasons).toContain('no-host-restriction');
  });

  it('global exclusions', () => {
    const config = configWith(
      [
        profile('Everywhere', {
          id: 'fix-excl',
          requestHeaders: [blankHeaderOp({ id: 'h1', name: 'X-Everywhere', value: '1' })],
        }),
      ],
      { exclusions: { urlContains: ['/healthz'], urlRegex: ['\\.(png|jpe?g|gif)$'] } },
    );
    const snapshot = compareWithFixture(compile(config), 'global-exclusions');
    expect(ruleCount(snapshot)).toBe(3);
  });
});
