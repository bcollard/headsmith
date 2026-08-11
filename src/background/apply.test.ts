import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../../test/fakes/chrome';
/* Type-only namespace import. The modules themselves are re-imported per test
   through vi.resetModules(), so the fake chrome is installed before they
   capture anything -- but the helpers below still need the module's type. */
import type * as SchemaModule from '../core/schema';

let fake: FakeChrome;

async function freshModules() {
  vi.resetModules();
  fake = installFakeChrome();
  const apply = await import('./apply');
  const store = await import('./store');
  const secrets = await import('./secrets');
  const schema = await import('../core/schema');
  apply.resetApplyState();
  return { apply, store, secrets, schema };
}

function profileWith(
  schema: typeof SchemaModule,
  headers: { name: string; value: string }[],
  urlContains: string[] = [],
) {
  return {
    ...schema.blankProfile(1),
    name: 'Test',
    match: {
      include: { domains: ['example.com'], urlContains, urlRegex: [] },
      exclude: { domains: [] },
      resourceTypes: [],
    },
    requestHeaders: headers.map((h) => schema.blankHeaderOp(h)),
    responseHeaders: [],
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('applyRules', () => {
  it('puts ordinary rules in the dynamic set and nothing in the session set', async () => {
    const { apply, store, schema } = await freshModules();
    const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }]);
    await store.saveConfig(
      schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
    );

    await apply.applyRules();

    expect(fake.dynamicSnapshot()).toHaveLength(1);
    expect(fake.sessionSnapshot()).toHaveLength(0);
  });

  it('replaces the previous rule set rather than accumulating', async () => {
    // Each update removes everything and adds the new set in one call, so
    // there is no window where a half-applied set could match a request.
    const { apply, store, schema } = await freshModules();
    const first = profileWith(schema, [{ name: 'X-One', value: '1' }]);
    await store.saveConfig(
      schema.parseConfig({ ...schema.defaultConfig(), profiles: [first], activeProfileId: first.id }),
    );
    await apply.applyRules();

    const second = profileWith(schema, [{ name: 'X-Two', value: '2' }]);
    await store.saveConfig(
      schema.parseConfig({ ...schema.defaultConfig(), profiles: [second], activeProfileId: second.id }),
    );
    await apply.applyRules();

    const rules = fake.dynamicSnapshot();
    expect(rules).toHaveLength(1);
    expect(JSON.stringify(rules)).toContain('x-two');
    expect(JSON.stringify(rules)).not.toContain('x-one');
  });

  it('clears the rules when paused', async () => {
    const { apply, store, schema } = await freshModules();
    const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }]);
    const config = schema.parseConfig({
      ...schema.defaultConfig(),
      profiles: [profile],
      activeProfileId: profile.id,
    });

    await store.saveConfig(config);
    await apply.applyRules();
    expect(fake.dynamicSnapshot()).toHaveLength(1);

    await store.saveConfig({ ...config, paused: true });
    await apply.applyRules();
    expect(fake.dynamicSnapshot()).toHaveLength(0);
  });

  it('writes a status object for the popup', async () => {
    const { apply, store, schema } = await freshModules();
    const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }]);
    await store.saveConfig(
      schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
    );

    await apply.applyRules(1234);
    const status = await store.loadStatus();

    expect(status?.updatedAt).toBe(1234);
    expect(status?.budget.dynamic).toBe(1);
    expect(status?.ruleErrors).toEqual([]);
  });

  describe('per-rule fallback', () => {
    it('keeps the good rules when one is rejected', async () => {
      /* declarativeNetRequest rejects the whole batch for one bad rule. Without
         the fallback, a single bad regex would silently disable everything the
         user has configured. */
      const { apply, store, schema } = await freshModules();
      const profile = profileWith(
        schema,
        [{ name: 'X-Env', value: 'staging' }],
        ['/good-one', '/poisoned', '/good-two'],
      );
      await store.saveConfig(
        schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
      );

      const real = fake.chrome.declarativeNetRequest.updateDynamicRules;
      fake.chrome.declarativeNetRequest.updateDynamicRules = vi.fn(
        async (options: { addRules?: { condition?: { urlFilter?: string } }[] }) => {
          if (options.addRules?.some((r) => r.condition?.urlFilter === '/poisoned')) {
            throw new Error('rejected by the engine');
          }
          return real(options as never);
        },
      );

      const outcome = await apply.applyRules();

      expect(fake.dynamicSnapshot()).toHaveLength(2);
      expect(outcome?.errors).toHaveLength(1);
      expect(outcome?.errors[0]).toContain('x-env');
    });

    it('finds one bad rule among many without testing them all', async () => {
      /* Recovery bisects rather than re-adding one rule at a time. With 64
         rules that is ~14 engine calls instead of 64, every time anyone has a
         typo. The assertion is on call count because that is the property --
         both strategies find the rule; only one of them is cheap. */
      const { apply, store, schema } = await freshModules();
      const filters = Array.from({ length: 64 }, (_, i) => `/path-${i}`);
      const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }], filters);
      await store.saveConfig(
        schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
      );

      const real = fake.chrome.declarativeNetRequest.updateDynamicRules;
      let addCalls = 0;
      fake.chrome.declarativeNetRequest.updateDynamicRules = vi.fn(
        async (options: { addRules?: { condition?: { urlFilter?: string } }[] }) => {
          if (options.addRules?.length) addCalls++;
          if (options.addRules?.some((r) => r.condition?.urlFilter === '/path-40')) {
            throw new Error('rejected by the engine');
          }
          return real(options as never);
        },
      );

      const outcome = await apply.applyRules();

      expect(outcome?.errors).toHaveLength(1);
      expect(fake.dynamicSnapshot()).toHaveLength(63);
      // One failed batch, then a bisection of depth ~log2(64).
      expect(addCalls).toBeLessThan(30);
    });

    it('gives up quickly when the failure is not any single rule', async () => {
      /* A quota rejection fails every subdivision. Bisecting still terminates,
         and does not spend 64 calls discovering that nothing works. */
      const { apply, store, schema } = await freshModules();
      const filters = Array.from({ length: 32 }, (_, i) => `/p-${i}`);
      const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }], filters);
      await store.saveConfig(
        schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
      );

      fake.chrome.declarativeNetRequest.updateDynamicRules = vi.fn(
        async (options: { addRules?: unknown[] }) => {
          if (options.addRules?.length) throw new Error('quota exceeded');
        },
      );

      const outcome = await apply.applyRules();

      // Every rule is reported, and the extension is still alive.
      expect(outcome?.errors).toHaveLength(32);
      expect(outcome?.errors[0]).toContain('quota exceeded');
    });

    it('names the offending rule by profile and header', async () => {
      const { apply, store, schema } = await freshModules();
      const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }]);
      await store.saveConfig(
        schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
      );

      fake.chrome.declarativeNetRequest.updateDynamicRules = vi.fn(
        async (options: { addRules?: unknown[] }) => {
          if (options.addRules?.length) throw new Error('nope');
        },
      );

      const outcome = await apply.applyRules();
      expect(outcome?.errors[0]).toMatch(/^Test: x-env — nope$/);
    });
  });

  describe('serialisation', () => {
    it('coalesces a concurrent call rather than racing', async () => {
      /* Storage changes, alarms and startup can all fire together. Overlapping
         updates would race on the remove-then-add, so the second call folds
         into a single follow-up run. */
      const { apply, store, schema } = await freshModules();
      const profile = profileWith(schema, [{ name: 'X-Env', value: 'staging' }]);
      await store.saveConfig(
        schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
      );

      const [first, second] = await Promise.all([apply.applyRules(), apply.applyRules()]);

      // One call did the work; the other returned undefined having queued.
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(fake.dynamicSnapshot()).toHaveLength(1);
    });
  });
});

describe('clearSessionRules', () => {
  it('removes every session rule and leaves the dynamic set alone', async () => {
    const { apply, store, secrets, schema } = await freshModules();
    const profile = {
      ...profileWith(schema, [{ name: 'X-Env', value: 'staging' }]),
      requestHeaders: [
        schema.blankHeaderOp({ name: 'X-Env', value: 'staging' }),
        schema.blankHeaderOp({ name: 'Authorization', secretId: 's1', sensitive: true }),
      ],
    };
    const config = schema.parseConfig({
      ...schema.defaultConfig(),
      profiles: [profile],
      activeProfileId: profile.id,
    });

    await store.saveConfig(config);
    await secrets.putSecret('s1', 'Bearer token', config.settings);
    await apply.applyRules();

    expect(fake.sessionSnapshot()).toHaveLength(1);
    expect(fake.dynamicSnapshot()).toHaveLength(1);

    const removed = await apply.clearSessionRules();

    expect(removed).toBe(1);
    expect(fake.sessionSnapshot()).toHaveLength(0);
    expect(fake.dynamicSnapshot()).toHaveLength(1);
  });

  it('is a no-op when there is nothing to clear', async () => {
    const { apply } = await freshModules();
    expect(await apply.clearSessionRules()).toBe(0);
  });
});

describe('the toolbar badge', () => {
  it('counts headers actually emitted, not headers configured', async () => {
    /* A badge counting configured headers would claim a credential rule is
       active while it was being withheld. */
    const { apply, store, schema } = await freshModules();
    const profile = {
      ...profileWith(schema, []),
      requestHeaders: [
        schema.blankHeaderOp({ name: 'X-Env', value: 'staging' }),
        schema.blankHeaderOp({ name: 'Authorization', secretId: 'missing', sensitive: true }),
      ],
    };
    await store.saveConfig(
      schema.parseConfig({ ...schema.defaultConfig(), profiles: [profile], activeProfileId: profile.id }),
    );

    await apply.applyRules();

    // One emitted, one withheld.
    expect(fake.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
  });

  it('shows "off" when paused', async () => {
    const { apply, store, schema } = await freshModules();
    await store.saveConfig({ ...schema.defaultConfig(), paused: true });
    await apply.applyRules();
    expect(fake.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'off' });
  });

  it('shows "lock" when the vault is locked', async () => {
    const { apply, store, schema } = await freshModules();
    const base = schema.defaultConfig();
    await store.saveConfig(
      schema.parseConfig({ ...base, settings: { ...base.settings, credentialStorage: 'vault' } }),
    );
    await apply.applyRules();
    expect(fake.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'lock' });
  });
});
