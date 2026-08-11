import { describe, it, expect } from 'vitest';
import { evaluateProfile, isHostRestricted, insecureHosts, describeBlock } from './policy';
import { blankHeaderOp, blankProfile, parseConfig, type MatchSet, type Profile } from './schema';

const settings = parseConfig({}).settings;

function match(patch: Partial<MatchSet['include']> = {}): MatchSet {
  return {
    include: { domains: [], urlContains: [], urlRegex: [], ...patch },
    exclude: { domains: [] },
    resourceTypes: [],
  };
}

function withHeaders(headers: Profile['requestHeaders'], m: MatchSet = match()): Profile {
  return { ...blankProfile(1), match: m, requestHeaders: headers, responseHeaders: [] };
}

describe('isHostRestricted', () => {
  it('accepts a domain include', () => {
    expect(isHostRestricted(match({ domains: ['api.example.com'] }))).toBe(true);
  });

  it('accepts a substantive url fragment', () => {
    expect(isHostRestricted(match({ urlContains: ['api.example.com/v2'] }))).toBe(true);
  });

  it('accepts a regex with something literal in it', () => {
    expect(isHostRestricted(match({ urlRegex: ['^https://api\\.example\\.com/'] }))).toBe(true);
  });

  it('rejects an empty match set', () => {
    expect(isHostRestricted(match())).toBe(false);
  });

  // The protection is worthless if typing a star satisfies it, which is the
  // whole reason these cases are enumerated.
  const wildcards = ['*', '<all_urls>', '*://*/*', 'https://*/*', '/', '.*', '^.*$', 'http://'];
  for (const value of wildcards) {
    it(`rejects the wildcard "${value}" as a url fragment`, () => {
      expect(isHostRestricted(match({ urlContains: [value] }))).toBe(false);
    });
  }

  it('rejects a regex made only of metacharacters', () => {
    expect(isHostRestricted(match({ urlRegex: ['^.*$'] }))).toBe(false);
    expect(isHostRestricted(match({ urlRegex: ['.+'] }))).toBe(false);
    expect(isHostRestricted(match({ urlRegex: ['\\w*'] }))).toBe(false);
  });

  it('rejects a fragment too short to name anything', () => {
    expect(isHostRestricted(match({ urlContains: ['ab'] }))).toBe(false);
  });
});

describe('insecureHosts', () => {
  it('flags a plain http host', () => {
    expect(insecureHosts(match({ urlContains: ['http://api.internal/v1'] }))).toEqual([
      'http://api.internal/v1',
    ]);
  });

  it('does not flag https', () => {
    expect(insecureHosts(match({ urlContains: ['https://api.example.com'] }))).toEqual([]);
  });

  it('does not flag a scheme-agnostic fragment', () => {
    expect(insecureHosts(match({ urlContains: ['api.example.com/v2'] }))).toEqual([]);
  });

  it('exempts loopback and local development names', () => {
    // Warning about plaintext http on localhost would train users to ignore
    // the warning, which costs more than it saves.
    for (const host of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://[::1]/',
      'http://api.local/',
      'http://svc.test/',
    ]) {
      expect(insecureHosts(match({ urlContains: [host] }))).toEqual([]);
    }
  });
});

describe('evaluateProfile', () => {
  const secret = blankHeaderOp({ name: 'Authorization', secretId: 'secret-1', sensitive: true });
  const plain = blankHeaderOp({ name: 'X-Debug', value: 'on' });

  it('treats a profile with no credential as unblocked', () => {
    const verdict = evaluateProfile(withHeaders([plain]), settings);
    expect(verdict.hasSensitive).toBe(false);
    expect(verdict.blocked).toBe(false);
  });

  it('blocks a credential profile with no host restriction', () => {
    const verdict = evaluateProfile(withHeaders([secret]), settings);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reasons).toContain('no-host-restriction');
  });

  it('allows one once a host is named', () => {
    const verdict = evaluateProfile(
      withHeaders([secret], match({ domains: ['api.example.com'] })),
      settings,
      { resolvedIds: new Set(['secret-1']) },
    );
    expect(verdict.blocked).toBe(false);
  });

  it('honours the per-profile escape hatch', () => {
    const profile = {
      ...withHeaders([secret]),
      allowGlobalSensitive: true,
    };
    const verdict = evaluateProfile(profile, settings, { resolvedIds: new Set(['secret-1']) });
    expect(verdict.blocked).toBe(false);
  });

  it('does not apply the escape hatch to other profiles', () => {
    // Accepting the risk once for a local dev profile must not disable the
    // protection for the profile holding a production token.
    const opted = { ...withHeaders([secret]), allowGlobalSensitive: true };
    const other = { ...withHeaders([secret]), id: 'other' };
    expect(evaluateProfile(opted, settings, { resolvedIds: new Set(['secret-1']) }).blocked).toBe(false);
    expect(evaluateProfile(other, settings, { resolvedIds: new Set(['secret-1']) }).blocked).toBe(true);
  });

  it('respects requireExplicitHosts being switched off', () => {
    const verdict = evaluateProfile(withHeaders([secret]), { ...settings, requireExplicitHosts: false }, {
      resolvedIds: new Set(['secret-1']),
    });
    expect(verdict.blocked).toBe(false);
  });

  it('blocks on a locked vault, but only in vault mode', () => {
    const profile = withHeaders([secret], match({ domains: ['api.example.com'] }));
    const context = { unlocked: false, resolvedIds: new Set(['secret-1']) };

    expect(evaluateProfile(profile, { ...settings, credentialStorage: 'vault' }, context).reasons).toContain(
      'vault-locked',
    );
    // Session mode has no lock, so "locked" is not a state it can be in.
    expect(evaluateProfile(profile, { ...settings, credentialStorage: 'session' }, context).reasons).not.toContain(
      'vault-locked',
    );
  });

  it('reports an unresolvable secret id', () => {
    const verdict = evaluateProfile(
      withHeaders([secret], match({ domains: ['api.example.com'] })),
      settings,
      { resolvedIds: new Set() },
    );
    expect(verdict.reasons).toContain('missing-credential');
    expect(verdict.missingSecretIds).toEqual(['secret-1']);
  });

  it('reports a sensitive header carrying no secret reference', () => {
    const unmanaged = blankHeaderOp({ name: 'X-Api-Key', value: 'inline' });
    const verdict = evaluateProfile(
      withHeaders([unmanaged], match({ domains: ['api.example.com'] })),
      settings,
      { resolvedIds: new Set() },
    );
    expect(verdict.reasons).toContain('missing-credential');
    expect(verdict.unmanagedHeaders).toContain('X-Api-Key');
  });

  it('skips the resolution check when no resolved set is supplied', () => {
    // The editor evaluates profiles without touching the secret store.
    const verdict = evaluateProfile(
      withHeaders([secret], match({ domains: ['api.example.com'] })),
      settings,
    );
    expect(verdict.reasons).not.toContain('missing-credential');
  });

  it('warns about an insecure host without blocking on it', () => {
    const verdict = evaluateProfile(
      withHeaders([secret], match({ urlContains: ['http://api.internal/v1'] })),
      settings,
      { resolvedIds: new Set(['secret-1']) },
    );
    expect(verdict.warnings).toEqual([
      { kind: 'insecure-host', hosts: ['http://api.internal/v1'] },
    ]);
    expect(verdict.blocked).toBe(false);
  });

  it('can have the insecure-host warning switched off', () => {
    const verdict = evaluateProfile(
      withHeaders([secret], match({ urlContains: ['http://api.internal/v1'] })),
      { ...settings, warnOnInsecureHosts: false },
      { resolvedIds: new Set(['secret-1']) },
    );
    expect(verdict.warnings).toEqual([]);
  });

  it('ignores a disabled sensitive header', () => {
    const disabled = { ...secret, enabled: false };
    expect(evaluateProfile(withHeaders([disabled]), settings).hasSensitive).toBe(false);
  });
});

describe('describeBlock', () => {
  it('leads with the host restriction, which is the actionable one', () => {
    expect(describeBlock(['no-host-restriction', 'missing-credential'])).toMatch(/filter/i);
  });

  it('describes each reason on its own', () => {
    expect(describeBlock(['vault-locked'])).toMatch(/unlock/i);
    expect(describeBlock(['missing-credential'])).toMatch(/enter the credential/i);
  });

  it('says nothing when nothing is blocked', () => {
    expect(describeBlock([])).toBe('');
  });
});
