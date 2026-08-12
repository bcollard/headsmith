import { describe, it, expect, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../../test/fakes/chrome';

let fake: FakeChrome;

async function freshModules() {
  vi.resetModules();
  fake = installFakeChrome();
  const store = await import('./store');
  const schema = await import('../core/schema');
  return { store, schema };
}

describe('loadConfig', () => {
  it('returns a default config when storage is empty', async () => {
    const { store } = await freshModules();
    const config = await store.loadConfig();
    expect(config.profiles).toHaveLength(1);
  });

  it('round-trips a saved config', async () => {
    const { store, schema } = await freshModules();
    const config = schema.defaultConfig();
    await store.saveConfig(config);
    expect(await store.loadConfig()).toEqual(config);
  });

  it('repairs corrupt stored data rather than failing to start', async () => {
    const { store } = await freshModules();
    await fake.chrome.storage.local.set({ config: { profiles: 'not an array' } });
    const config = await store.loadConfig();
    expect(config.profiles.length).toBeGreaterThan(0);
  });
});

describe('loadAndMigrate', () => {
  it('writes a default config on first run', async () => {
    const { store } = await freshModules();
    const { config, migrated } = await store.loadAndMigrate();

    expect(migrated).toEqual([]);
    // Persisted, so the next read does not rebuild it.
    expect(await fake.chrome.storage.local.get('config')).toHaveProperty('config');
    expect(config.profiles).toHaveLength(1);
  });

  it('leaves current data untouched and does not rewrite it', async () => {
    /* The overwhelmingly common case. Rewriting on every worker wake-up would
       churn storage and re-fire the change listener that triggers a rebuild. */
    const { store, schema } = await freshModules();
    const config = schema.defaultConfig();
    await store.saveConfig(config);

    const setCalls = fake.chrome.storage.local.set.mock.calls.length;
    const result = await store.loadAndMigrate();

    expect(result.migrated).toEqual([]);
    expect(fake.chrome.storage.local.set.mock.calls.length).toBe(setCalls);
  });

  it('migrates unversioned data and persists the result', async () => {
    const { store, schema } = await freshModules();
    await fake.chrome.storage.local.set({
      config: { profiles: [{ id: 'old', name: 'Legacy' }] },
    });

    const { config } = await store.loadAndMigrate();
    expect(config.version).toBe(schema.SCHEMA_VERSION);
    expect(config.profiles[0]!.name).toBe('Legacy');

    // Written back, so the migration does not re-run on every read.
    const stored = (await fake.chrome.storage.local.get('config')) as {
      config: { version: number };
    };
    expect(stored.config.version).toBe(schema.SCHEMA_VERSION);
  });
});

describe('status', () => {
  it('round-trips, and is absent before the first apply', async () => {
    const { store } = await freshModules();
    expect(await store.loadStatus()).toBeUndefined();

    const status = {
      ruleErrors: [],
      blocked: [],
      problems: [],
      vaultUnlocked: true,
      missingPermissions: [],
      budget: { dynamic: 3, session: 0, pressure: 0.001, breaches: [] },
      updatedAt: 42,
    };
    await store.saveStatus(status);
    expect(await store.loadStatus()).toEqual(status);
  });

  it('is stored under a different key from the config', async () => {
    /* The worker writes status on every apply. If it shared the config key,
       or if the change listener watched every key, each apply would trigger
       another apply. */
    const { store } = await freshModules();
    expect(store.STATUS_KEY).not.toBe(store.CONFIG_KEY);
  });
});
