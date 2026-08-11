import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../../test/fakes/chrome';
import type { Settings } from '../core/schema';

const PASSPHRASE = 'a sufficiently long vault passphrase';
const SLOW = 60_000;

let fake: FakeChrome;

async function freshModules() {
  vi.resetModules();
  fake = installFakeChrome();
  const secrets = await import('./secrets');
  const schema = await import('../core/schema');
  return { secrets, schema };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    credentialStorage: 'session',
    requireExplicitHosts: true,
    warnOnInsecureHosts: true,
    lockAfterMinutes: 15,
    disableAutoLock: false,
    omitCredentialsByDefault: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('session mode', () => {
  it('stores and resolves a value', async () => {
    const { secrets } = await freshModules();
    const s = settings();
    await secrets.putSecret('s1', 'value-one', s);
    expect(await secrets.resolveSecrets(s)).toEqual({ s1: 'value-one' });
  });

  it('reports a failure rather than silently not storing', async () => {
    /* Fail closed: a caller that thinks it saved a credential will show the
       user a working profile that quietly sends nothing. */
    const { secrets } = await freshModules();
    fake.chrome.storage.session.set = vi.fn(async () => {
      throw new Error('quota');
    });
    expect(await secrets.putSecret('s1', 'value', settings())).toEqual({
      ok: false,
      error: 'no-session-storage',
    });
  });

  it('deletes a value', async () => {
    const { secrets } = await freshModules();
    const s = settings();
    await secrets.putSecret('s1', 'value', s);
    await secrets.deleteSecret('s1');
    expect(await secrets.resolveSecrets(s)).toEqual({});
  });

  it('cannot reveal, because there is nothing to authenticate against', async () => {
    const { secrets } = await freshModules();
    expect(await secrets.revealSecret('s1', PASSPHRASE, settings())).toEqual({
      ok: false,
      error: 'not-encrypted',
    });
  });
});

describe('vault mode', () => {
  const vaultSettings = settings({ credentialStorage: 'vault' });

  it('stores ciphertext and resolves through the cached key', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer stored', vaultSettings);

    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({ s1: 'Bearer stored' });
    expect(fake.dumpLocalJson()).not.toContain('Bearer stored');
  });

  it('refuses to store while locked', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.lock();
    expect(await secrets.putSecret('s1', 'value', vaultSettings)).toEqual({
      ok: false,
      error: 'locked',
    });
  });

  it('resolves nothing while locked', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer stored', vaultSettings);
    await secrets.lock();
    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({});
  });

  it('resolves again after unlocking', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer stored', vaultSettings);
    await secrets.lock();

    expect((await secrets.unlock(PASSPHRASE, vaultSettings)).ok).toBe(true);
    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({ s1: 'Bearer stored' });
  });

  it('rejects a wrong passphrase', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.lock();
    expect(await secrets.unlock('wrong passphrase', vaultSettings)).toEqual({
      ok: false,
      error: 'incorrect-passphrase',
    });
  });

  it('reveals only with a passphrase that actually decrypts', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer revealed', vaultSettings);

    expect(await secrets.revealSecret('s1', PASSPHRASE, vaultSettings)).toEqual({
      ok: true,
      value: 'Bearer revealed',
    });
    expect(await secrets.revealSecret('s1', 'wrong', vaultSettings)).toEqual({
      ok: false,
      error: 'decrypt-failed',
    });
  });

  it('reveals from ciphertext even while locked, given the passphrase', { timeout: SLOW }, async () => {
    /* The reveal path re-derives from the vault salt and never reads the
       session cache, so it does not depend on the vault being open. */
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer revealed', vaultSettings);
    await secrets.lock();

    expect(await secrets.revealSecret('s1', PASSPHRASE, vaultSettings)).toEqual({
      ok: true,
      value: 'Bearer revealed',
    });
  });

  it('rotates the passphrase without losing secrets', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'Bearer kept', vaultSettings);

    expect(await secrets.rotatePassphrase(PASSPHRASE, 'a different passphrase')).toMatchObject({
      ok: true,
    });
    await secrets.lock();
    expect((await secrets.unlock('a different passphrase', vaultSettings)).ok).toBe(true);
    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({ s1: 'Bearer kept' });
  });

  it('throttles after repeated wrong passphrases', { timeout: SLOW }, async () => {
    /* PBKDF2 at 600k iterations is the real defence; this makes the cost
       explicit rather than leaving the rate up to the machine. */
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.lock();

    for (let i = 0; i < 5; i++) await secrets.unlock('wrong', vaultSettings);

    const started = Date.now();
    await secrets.unlock('wrong', vaultSettings);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it('clears the failure count on a successful unlock', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.lock();

    await secrets.unlock('wrong', vaultSettings);
    await secrets.unlock(PASSPHRASE, vaultSettings);
    await secrets.lock();

    const started = Date.now();
    await secrets.unlock('wrong', vaultSettings);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('mode switching', () => {
  it('carries values from session into the vault', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.putSecret('s1', 'carried value', settings());
    await secrets.initVault(PASSPHRASE);

    const result = await secrets.switchMode('vault', settings());
    expect(result).toMatchObject({ ok: true, carried: 1 });

    const vaultSettings = settings({ credentialStorage: 'vault' });
    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({ s1: 'carried value' });
    expect(fake.dumpLocalJson()).not.toContain('carried value');
  });

  it('drops the session copy when moving into the vault', { timeout: SLOW }, async () => {
    /* Leaving it would mean the value lives in two places and a lock would
       clear only one of them. */
    const { secrets } = await freshModules();
    await secrets.putSecret('s1', 'carried value', settings());
    await secrets.initVault(PASSPHRASE);
    await secrets.switchMode('vault', settings());

    expect(fake.dumpSessionJson()).not.toContain('carried value');
  });

  it('refuses to move into a locked vault', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.putSecret('s1', 'value', settings());
    await secrets.initVault(PASSPHRASE);
    await secrets.lock();

    expect(await secrets.switchMode('vault', settings())).toMatchObject({
      ok: false,
      error: 'locked',
    });
  });

  it('carries values from the vault back to session', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    const vaultSettings = settings({ credentialStorage: 'vault' });
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'value back', vaultSettings);

    expect(await secrets.switchMode('session', vaultSettings)).toMatchObject({ ok: true, carried: 1 });
    expect(await secrets.resolveSecrets(settings())).toEqual({ s1: 'value back' });
  });
});

describe('pruneOrphans', () => {
  it('removes values nothing references and keeps the rest', async () => {
    const { secrets } = await freshModules();
    const s = settings();
    await secrets.putSecret('kept', 'a', s);
    await secrets.putSecret('orphan', 'b', s);

    expect(await secrets.pruneOrphans(['kept'])).toEqual(['orphan']);
    expect(await secrets.resolveSecrets(s)).toEqual({ kept: 'a' });
  });

  it('prunes vault records too', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    const vaultSettings = settings({ credentialStorage: 'vault' });
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('kept', 'a', vaultSettings);
    await secrets.putSecret('orphan', 'b', vaultSettings);

    expect(await secrets.pruneOrphans(['kept'])).toEqual(['orphan']);
    expect(await secrets.resolveSecrets(vaultSettings)).toEqual({ kept: 'a' });
  });
});

describe('auto-lock', () => {
  const vaultSettings = settings({ credentialStorage: 'vault' });

  it('schedules an alarm at the deadline', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.noteActivity(vaultSettings, 1_000_000);

    const [alarm] = fake.pendingAlarms();
    expect(alarm?.when).toBe(1_000_000 + 15 * 60_000);
  });

  it('locks when the deadline has passed', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.noteActivity(vaultSettings, 1_000_000);

    const result = await secrets.handleLockAlarm(vaultSettings, 1_000_000 + 16 * 60_000);
    expect(result.locked).toBe(true);
    expect(await secrets.isUnlocked()).toBe(false);
  });

  it('reschedules instead of locking when activity pushed the deadline out', { timeout: SLOW }, async () => {
    /* Alarms can fire late, and activity after the alarm was set extends the
       deadline. Locking on the alarm alone would close the vault early. */
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.noteActivity(vaultSettings, 1_000_000);

    const result = await secrets.handleLockAlarm(vaultSettings, 1_000_000 + 60_000);
    expect(result).toEqual({ locked: false, reason: 'not-yet-due' });
    expect(await secrets.isUnlocked()).toBe(true);
  });

  it('does nothing when auto-lock is switched off', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    const noLock = settings({ credentialStorage: 'vault', disableAutoLock: true });
    await secrets.initVault(PASSPHRASE);
    await secrets.noteActivity(noLock, 1_000_000);

    expect(fake.pendingAlarms()).toHaveLength(0);
    expect(await secrets.handleLockAlarm(noLock)).toEqual({
      locked: false,
      reason: 'auto-lock-disabled',
    });
  });

  it('does not schedule anything in session mode', async () => {
    // Session mode has no lock: the browser exiting is the lock.
    const { secrets } = await freshModules();
    await secrets.noteActivity(settings(), 1_000_000);
    expect(fake.pendingAlarms()).toHaveLength(0);
  });

  it('is a no-op when already locked', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    expect(await secrets.handleLockAlarm(vaultSettings)).toEqual({
      locked: false,
      reason: 'already-locked',
    });
  });
});

describe('lock', () => {
  it('clears the key and any cached values but keeps the ciphertext', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    const vaultSettings = settings({ credentialStorage: 'vault' });
    await secrets.initVault(PASSPHRASE);
    await secrets.putSecret('s1', 'value', vaultSettings);

    await secrets.lock();

    expect(await secrets.isUnlocked()).toBe(false);
    expect(fake.dumpSessionJson()).not.toContain('vaultKey');
    // The vault itself survives, so unlocking restores everything.
    expect(await secrets.vaultExists()).toBe(true);
  });
});

describe('resetVault', () => {
  it('removes the vault entirely', { timeout: SLOW }, async () => {
    const { secrets } = await freshModules();
    await secrets.initVault(PASSPHRASE);
    await secrets.resetVault();
    expect(await secrets.vaultExists()).toBe(false);
  });
});
