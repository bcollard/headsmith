/* Invariant 3: no plaintext secrets at rest.
 *
 * The check the kickoff asks for, and the reason there is no
 * persistent-plaintext credential mode: write a sensitive header, dump the
 * entire fake storage.local, and assert the cleartext appears nowhere in it.
 *
 * The value under test is a distinctive marker string. Searching the whole
 * serialised storage area rather than specific keys is deliberate -- the
 * failure this is guarding against is a credential ending up somewhere nobody
 * thought to look, which is exactly what a key-by-key assertion would miss.
 *
 * storage.session is checked separately and held to a weaker standard on
 * purpose: in session mode a credential legitimately lives there in cleartext.
 * That area is cleared by Chrome when the browser process exits and never
 * reaches disk, which is the whole basis of the mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../fakes/chrome';
import type * as SchemaModule from '../../src/core/schema';

const TOKEN = 'PLAINTEXT-CANARY-eyJhbGciOiJIUzI1NiJ9-DO-NOT-PERSIST';
const PASSPHRASE = 'a good long passphrase for the vault';

let fake: FakeChrome;

/* The modules under test read `chrome` through a getter, but they are imported
   once per module graph -- so the fake is installed before a fresh import. */
async function freshModules() {
  vi.resetModules();
  fake = installFakeChrome();
  const secrets = await import('../../src/background/secrets');
  const store = await import('../../src/background/store');
  const apply = await import('../../src/background/apply');
  const schema = await import('../../src/core/schema');
  return { secrets, store, apply, schema };
}

/* A config with one credential-bearing header, scoped to a host so the policy
   gate lets it through and the credential is actually resolved. */
function configWithSecret(schema: typeof SchemaModule) {
  const profile = {
    ...schema.blankProfile(1),
    name: 'API',
    match: {
      include: { domains: ['api.example.com'], urlContains: [], urlRegex: [] },
      exclude: { domains: [] },
      resourceTypes: [],
    },
    requestHeaders: [
      schema.blankHeaderOp({
        name: 'Authorization',
        secretId: 'secret-canary',
        sensitive: true,
      }),
    ],
    responseHeaders: [],
  };
  return schema.parseConfig({
    ...schema.defaultConfig(),
    profiles: [profile],
    activeProfileId: profile.id,
    secretsMeta: { 'secret-canary': { label: 'API token', createdAt: 0 } },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('session mode', () => {
  it('never writes the credential to storage.local', { timeout: 30_000 }, async () => {
    const { secrets, store, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('keeps it in storage.session, which the browser clears on exit', { timeout: 30_000 }, async () => {
    const { secrets, schema } = await freshModules();
    const config = configWithSecret(schema);

    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    // Present here by design: session mode's guarantee is "not on disk", not
    // "encrypted in memory".
    expect(fake.dumpSessionJson()).toContain(TOKEN);
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('keeps it out of storage.local through a full rule application', { timeout: 30_000 }, async () => {
    const { secrets, store, apply, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);
    apply.resetApplyState();
    const outcome = await apply.applyRules();

    // The credential did reach a rule -- otherwise this proves nothing.
    expect(JSON.stringify(fake.sessionSnapshot())).toContain(TOKEN);
    expect(outcome?.result.session.length).toBeGreaterThan(0);

    // ...and storage.local, which includes the status object the worker
    // writes for the popup, still holds no trace of it.
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('keeps it out of the dynamic rule set, which Chrome persists', { timeout: 30_000 }, async () => {
    const { secrets, store, apply, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);
    apply.resetApplyState();
    await apply.applyRules();

    expect(JSON.stringify(fake.dynamicSnapshot())).not.toContain(TOKEN);
  });
});

describe('vault mode', () => {
  it('writes only ciphertext to storage.local', { timeout: 60_000 }, async () => {
    const { secrets, store, schema } = await freshModules();
    const base = configWithSecret(schema);
    const config = schema.parseConfig({
      ...base,
      settings: { ...base.settings, credentialStorage: 'vault' },
    });

    await store.saveConfig(config);
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    expect(fake.dumpLocalJson()).not.toContain(TOKEN);

    /* The record really is there, just unreadable -- asserted on the stored
       structure rather than on a field name, so renaming a field cannot
       silently turn this into a test that passes because nothing was
       written at all. */
    const stored = fake.dumpLocal()['vault'] as {
      records: Record<string, { iv: string; ct: string }>;
    };
    const record = stored.records['secret-canary'];
    expect(record).toBeDefined();
    expect(record!.ct.length).toBeGreaterThan(0);
    expect(record!.ct).not.toContain(TOKEN);
  });

  it('does not mirror the plaintext into storage.session on unlock', { timeout: 60_000 }, async () => {
    /* Unlocking caches the derived key, not the credentials. Decrypting the
       whole vault into a session key on unlock would leave a readable dump of
       every credential sitting in a storage area for as long as the vault is
       open. */
    const { secrets, store, schema } = await freshModules();
    const base = configWithSecret(schema);
    const config = schema.parseConfig({
      ...base,
      settings: { ...base.settings, credentialStorage: 'vault' },
    });

    await store.saveConfig(config);
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);
    await secrets.lock();
    const result = await secrets.unlock(PASSPHRASE, config.settings);

    expect(result.ok).toBe(true);
    expect(fake.dumpSessionJson()).not.toContain(TOKEN);
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('withholds the credential entirely while locked', { timeout: 60_000 }, async () => {
    const { secrets, store, apply, schema } = await freshModules();
    const base = configWithSecret(schema);
    const config = schema.parseConfig({
      ...base,
      settings: { ...base.settings, credentialStorage: 'vault' },
    });

    await store.saveConfig(config);
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);
    await secrets.lock();

    apply.resetApplyState();
    const outcome = await apply.applyRules();

    expect(outcome?.result.session).toHaveLength(0);
    expect(JSON.stringify(fake.sessionSnapshot())).not.toContain(TOKEN);
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('drops the rules as well as the key when locking', { timeout: 60_000 }, async () => {
    /* Forgetting how to decrypt a credential does not stop the browser from
       continuing to send a rule it was already given. Locking has to remove
       the rules too. */
    const { secrets, store, apply, schema } = await freshModules();
    const base = configWithSecret(schema);
    const config = schema.parseConfig({
      ...base,
      settings: { ...base.settings, credentialStorage: 'vault' },
    });

    await store.saveConfig(config);
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);
    apply.resetApplyState();
    await apply.applyRules();
    expect(JSON.stringify(fake.sessionSnapshot())).toContain(TOKEN);

    await secrets.lock();
    await apply.clearSessionRules();

    expect(fake.sessionSnapshot()).toHaveLength(0);
    expect(JSON.stringify(fake.sessionSnapshot())).not.toContain(TOKEN);
  });
});

describe('the status object written for the popup', () => {
  it('names a failing rule by header only, never by value', { timeout: 30_000 }, async () => {
    /* Rule errors are written to storage.local so the popup can show them. A
       rejected rule may carry a credential, so the error string must contain
       the header name and nothing else. */
    const { secrets, store, apply, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    /* Mirrors how Chrome actually fails: a rule submission is rejected while
       a remove-only call succeeds. That drives the per-rule retry, which is
       the path that produces the error strings. */
    fake.chrome.declarativeNetRequest.updateSessionRules = vi.fn(
      async (options: { addRules?: unknown[] }) => {
        if (options.addRules?.length) throw new Error('simulated engine rejection');
      },
    );

    apply.resetApplyState();
    const outcome = await apply.applyRules();

    expect(outcome?.errors.length).toBeGreaterThan(0);
    expect(outcome?.errors.join()).toContain('authorization');
    expect(outcome?.errors.join()).not.toContain(TOKEN);
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });

  it('still says nothing about the value when the engine rejects everything', { timeout: 30_000 }, async () => {
    /* The degenerate case -- quota exhaustion can make even a remove-only call
       fail. applyRules must survive it and write a status, rather than
       throwing and leaving the user with a silently dead extension. */
    const { secrets, store, apply, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    fake.chrome.declarativeNetRequest.updateSessionRules = vi.fn(async () => {
      throw new Error('simulated total failure');
    });

    apply.resetApplyState();
    const outcome = await apply.applyRules();

    expect(outcome).toBeDefined();
    expect(outcome!.errors.join()).toMatch(/could not clear/);
    expect(outcome!.errors.join()).not.toContain(TOKEN);
    expect(fake.dumpLocalJson()).not.toContain(TOKEN);
  });
});

describe('the exported config', () => {
  it('carries no credential, because none is stored in it', { timeout: 30_000 }, async () => {
    /* Export is just the config object. Since a sensitive header holds a
       secretId and never a value, an export omits credentials by construction
       rather than by remembering to filter them. */
    const { secrets, store, schema } = await freshModules();
    const config = configWithSecret(schema);

    await store.saveConfig(config);
    await secrets.putSecret('secret-canary', TOKEN, config.settings);

    const exported = JSON.stringify(await store.loadConfig());
    expect(exported).not.toContain(TOKEN);
    expect(exported).toContain('secret-canary');
  });
});
