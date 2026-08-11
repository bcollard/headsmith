import { describe, it, expect } from 'vitest';
import { planProfile, planIsEmpty, countActiveOps } from './plan';
import {
  isSensitiveHeaderName,
  carriesCredential,
  describeProblem,
  explainSensitivity,
  sensitivityOf,
} from './sensitivity';
import { blankHeaderOp, blankProfile, type Profile } from './schema';

function withHeaders(
  requestHeaders: Profile['requestHeaders'] = [],
  responseHeaders: Profile['responseHeaders'] = [],
): Profile {
  return { ...blankProfile(1), requestHeaders, responseHeaders };
}

describe('sensitive header detection', () => {
  const sensitive = [
    'Authorization',
    'authorization',
    'Proxy-Authorization',
    'Cookie',
    'Set-Cookie',
    'X-Api-Key',
    'api-key',
    'apikey',
    'X-Acme-Api-Key',
    'X-Access-Token',
    'X-Refresh-Token',
    'X-Session-Token',
    'X-Id-Token',
    'X-Client-Secret',
    'X-Request-Signature',
    'X-User-Password',
    'X-Amz-Security-Token',
  ];
  for (const name of sensitive) {
    it(`treats ${name} as a credential`, () => {
      expect(isSensitiveHeaderName(name)).toBe(true);
    });
  }

  const ordinary = ['Accept', 'User-Agent', 'X-Correlation-Id', 'Content-Type', 'X-Debug', 'Referer'];
  for (const name of ordinary) {
    it(`treats ${name} as ordinary`, () => {
      expect(isSensitiveHeaderName(name)).toBe(false);
    });
  }

  it('lets a user mark an unrecognised header as sensitive', () => {
    expect(carriesCredential(blankHeaderOp({ name: 'X-Internal-Thing', sensitive: true }))).toBe(true);
  });

  it('does not let a user unmark a recognised one', () => {
    // The flag can only add. Detection that can be switched off is not a
    // safety property.
    expect(carriesCredential(blankHeaderOp({ name: 'Authorization', sensitive: false }))).toBe(true);
  });

  it('does not treat removing a credential header as carrying one', () => {
    expect(carriesCredential(blankHeaderOp({ name: 'Authorization', operation: 'remove' }))).toBe(false);
  });
});

describe('explaining why a header was flagged', () => {
  /* A lock icon that appears without explanation reads as a bug, and the first
     thing anyone does with an unexplained restriction is try to turn it off.
     Detection therefore carries a reason the editor can show. */
  it('names the convention that matched', () => {
    expect(explainSensitivity(blankHeaderOp({ name: 'Authorization' }))).toMatch(
      /HTTP authentication/i,
    );
    expect(explainSensitivity(blankHeaderOp({ name: 'X-Acme-Api-Key' }))).toMatch(/API key/i);
    expect(explainSensitivity(blankHeaderOp({ name: 'X-Session-Token' }))).toMatch(/token/i);
    expect(explainSensitivity(blankHeaderOp({ name: 'X-Client-Secret' }))).toMatch(
      /secret material/i,
    );
    expect(explainSensitivity(blankHeaderOp({ name: 'Cookie' }))).toMatch(/cookie/i);
  });

  it('distinguishes a user-marked header from a detected one', () => {
    expect(explainSensitivity(blankHeaderOp({ name: 'X-Internal', sensitive: true }))).toMatch(
      /you marked it/i,
    );
  });

  it('says nothing about an ordinary header', () => {
    expect(explainSensitivity(blankHeaderOp({ name: 'Accept' }))).toBeNull();
  });

  it('reports the detected reason even when the flag is also set', () => {
    // The name is the stronger explanation: it says why it would have been
    // treated as a credential regardless of the flag.
    expect(
      explainSensitivity(blankHeaderOp({ name: 'Authorization', sensitive: true })),
    ).toMatch(/HTTP authentication/i);
  });
});

describe('sensitivityOf', () => {
  it('reports the reason as a stable code, not only prose', () => {
    expect(sensitivityOf('Authorization')?.reason).toBe('http-authentication');
    expect(sensitivityOf('X-Api-Key')?.reason).toBe('api-key');
    expect(sensitivityOf('X-Refresh-Token')?.reason).toBe('token');
    expect(sensitivityOf('X-Signing-Secret')?.reason).toBe('secret-material');
    expect(sensitivityOf('Set-Cookie')?.reason).toBe('cookie');
    expect(sensitivityOf('Accept')).toBeNull();
  });

  it('prefers the specific standard header over the shape rule', () => {
    // `Proxy-Authorization` is HTTP authentication, not a thing that happens
    // to end in a recognised word.
    expect(sensitivityOf('Proxy-Authorization')?.reason).toBe('http-authentication');
  });
});

describe('planProfile', () => {
  it('plans ordinary headers with their values', () => {
    const plan = planProfile(withHeaders([blankHeaderOp({ name: 'X-Env', value: 'staging' })]));
    expect(plan.requestOps).toEqual([
      { header: 'x-env', operation: 'set', value: 'staging', sensitive: false },
    ]);
  });

  it('skips disabled and unnamed headers', () => {
    const plan = planProfile(
      withHeaders([
        blankHeaderOp({ name: 'X-Off', value: '1', enabled: false }),
        blankHeaderOp({ name: '', value: '2' }),
        blankHeaderOp({ name: 'X-On', value: '3' }),
      ]),
    );
    expect(plan.requestOps.map((o) => o.header)).toEqual(['x-on']);
  });

  it('resolves a credential through the resolver', () => {
    const plan = planProfile(
      withHeaders([blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })]),
      (id) => (id === 's1' ? 'Bearer abc' : null),
    );
    expect(plan.requestOps).toEqual([
      { header: 'authorization', operation: 'set', value: 'Bearer abc', sensitive: true },
    ]);
  });

  it('drops rather than empties an unresolvable credential', () => {
    const plan = planProfile(
      withHeaders([blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })]),
      () => null,
    );
    expect(plan.requestOps).toEqual([]);
    expect(plan.missingSecretIds).toEqual(['s1']);
  });

  it('treats an empty-string secret as unresolved', () => {
    // An empty credential is the failure mode, not a valid value.
    const plan = planProfile(
      withHeaders([blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })]),
      () => '',
    );
    expect(plan.requestOps).toEqual([]);
    expect(plan.missingSecretIds).toEqual(['s1']);
  });

  it('drops a credential header with no resolver at all', () => {
    const plan = planProfile(
      withHeaders([blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })]),
    );
    expect(plan.requestOps).toEqual([]);
  });

  it('records an unmanaged credential header without emitting it', () => {
    const plan = planProfile(withHeaders([blankHeaderOp({ name: 'X-Api-Key', value: 'inline' })]));
    expect(plan.requestOps).toEqual([]);
    expect(plan.unmanagedHeaders).toEqual(['X-Api-Key']);
  });

  it('plans response headers independently', () => {
    const plan = planProfile(
      withHeaders([], [blankHeaderOp({ name: 'X-Frame-Options', value: 'DENY' })]),
    );
    expect(plan.requestOps).toEqual([]);
    expect(plan.responseOps).toHaveLength(1);
  });

  it('records an operation Chrome would reject instead of emitting it', () => {
    const plan = planProfile(
      withHeaders([blankHeaderOp({ name: 'X-Nope', value: 'v', operation: 'append' })]),
    );
    expect(plan.requestOps).toEqual([]);
    expect(plan.problems[0]!.problem.kind).toBe('append-not-allowed');
  });

  it('deduplicates repeated missing secret ids', () => {
    const plan = planProfile(
      withHeaders([
        blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true }),
        blankHeaderOp({ name: 'X-Api-Key', secretId: 's1', sensitive: true }),
      ]),
      () => null,
    );
    expect(plan.missingSecretIds).toEqual(['s1']);
  });
});

describe('planIsEmpty', () => {
  it('is true for a profile that would emit nothing', () => {
    expect(planIsEmpty(planProfile(withHeaders([])))).toBe(true);
  });

  it('is false as soon as one operation survives', () => {
    expect(planIsEmpty(planProfile(withHeaders([blankHeaderOp({ name: 'X', value: '1' })])))).toBe(false);
  });
});

describe('countActiveOps', () => {
  const profiles: Profile[] = [
    { ...blankProfile(1), requestHeaders: [blankHeaderOp({ name: 'X-A', value: '1' })], responseHeaders: [] },
    {
      ...blankProfile(2),
      requestHeaders: [blankHeaderOp({ name: 'X-B', value: '2' })],
      responseHeaders: [blankHeaderOp({ name: 'X-C', value: '3' })],
    },
  ];

  it('counts every operation across enabled profiles', () => {
    expect(countActiveOps(profiles, false)).toBe(3);
  });

  it('counts nothing when paused', () => {
    expect(countActiveOps(profiles, true)).toBe(0);
  });

  it('skips disabled profiles', () => {
    const off = [profiles[0]!, { ...profiles[1]!, enabled: false }];
    expect(countActiveOps(off, false)).toBe(1);
  });

  it('does not count a credential it cannot resolve', () => {
    // The badge must not claim a rule is active when it was withheld.
    const withSecret: Profile[] = [
      {
        ...blankProfile(1),
        requestHeaders: [blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true })],
        responseHeaders: [],
      },
    ];
    expect(countActiveOps(withSecret, false, () => null)).toBe(0);
    expect(countActiveOps(withSecret, false, () => 'Bearer x')).toBe(1);
  });
});

describe('describeProblem', () => {
  it('explains each kind in terms the editor can show', () => {
    expect(describeProblem({ kind: 'empty-name' })).toMatch(/no name/i);
    expect(describeProblem({ kind: 'invalid-name', header: 'X Bad' })).toContain('X Bad');
    expect(describeProblem({ kind: 'append-not-allowed', header: 'X-Nope' })).toMatch(/Set instead/i);
  });
});
