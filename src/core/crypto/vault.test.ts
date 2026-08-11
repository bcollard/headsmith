import { describe, it, expect } from 'vitest';
import {
  createVault,
  unlockVault,
  decryptOne,
  decryptAll,
  encryptSecret,
  decryptSecret,
  changePassphrase,
  validateVault,
  validateRecord,
  putRecord,
  removeRecord,
  exportKey,
  importKey,
  toB64,
  fromB64,
  KDF,
  CIPHER,
} from './vault';

/* PBKDF2 at 600,000 iterations costs roughly half a second per derivation,
   which is the point of it. Tests that need many derivations use a vault built
   once and reused; the ones that must derive get a generous timeout. */
const SLOW = 30_000;

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it('rejects anything that is not well-formed base64', () => {
    for (const bad of ['', 'not base64!', 'abc', '****', null, undefined, 42, {}]) {
      expect(() => fromB64(bad)).toThrow();
    }
  });

  it('rejects a value of the wrong length', () => {
    expect(() => fromB64(toB64(new Uint8Array(8)), { expectedBytes: 16 })).toThrow(/expected 16/);
  });

  it('names what failed without echoing the value', () => {
    // Error strings surface in the UI, so they must not leak material.
    expect(() => fromB64('!!!!', { label: 'session key' })).toThrow(/session key/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value', { timeout: SLOW }, async () => {
    const { key } = await createVault('correct horse battery staple');
    const record = await encryptSecret(key, 'Bearer abc123');
    expect(await decryptSecret(key, record)).toBe('Bearer abc123');
  });

  it('produces different ciphertext for the same plaintext', { timeout: SLOW }, async () => {
    // A fresh IV per encryption. Reuse under one key breaks AES-GCM badly.
    const { key } = await createVault('pass');
    const a = await encryptSecret(key, 'same value');
    const b = await encryptSecret(key, 'same value');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('never stores the plaintext in the record', { timeout: SLOW }, async () => {
    const { key } = await createVault('pass');
    const record = await encryptSecret(key, 'SECRET-MARKER-VALUE');
    expect(JSON.stringify(record)).not.toContain('SECRET-MARKER-VALUE');
  });

  it('returns null rather than throwing on a wrong key', { timeout: SLOW }, async () => {
    const a = await createVault('pass-a');
    const b = await createVault('pass-b');
    const record = await encryptSecret(a.key, 'value');
    expect(await decryptSecret(b.key, record)).toBeNull();
  });

  it('returns null on a tampered ciphertext', { timeout: SLOW }, async () => {
    // AES-GCM authenticates; a flipped bit must fail rather than decrypt to
    // garbage that then gets sent as a header value.
    const { key } = await createVault('pass');
    const record = await encryptSecret(key, 'value');
    const bytes = fromB64(record.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(await decryptSecret(key, { ...record, ciphertext: toB64(bytes) })).toBeNull();
  });

  it('returns null on a malformed record instead of crashing', { timeout: SLOW }, async () => {
    const { key } = await createVault('pass');
    for (const bad of [null, {}, { version: 99 }, { version: 1, algorithm: 'DES' }]) {
      expect(await decryptSecret(key, bad)).toBeNull();
    }
  });
});

describe('validateRecord', () => {
  it('rejects a ciphertext too short to carry an auth tag', () => {
    expect(() =>
      validateRecord({
        version: 1,
        algorithm: CIPHER.name,
        kdf: KDF.name,
        iv: toB64(new Uint8Array(CIPHER.ivBytes)),
        ciphertext: toB64(new Uint8Array(4)),
      }),
    ).toThrow(/too short/);
  });

  it('rejects an IV of the wrong size', () => {
    expect(() =>
      validateRecord({
        version: 1,
        algorithm: CIPHER.name,
        kdf: KDF.name,
        iv: toB64(new Uint8Array(8)),
        ciphertext: toB64(new Uint8Array(32)),
      }),
    ).toThrow(/IV/);
  });
});

describe('vault lifecycle', () => {
  it('unlocks with the right passphrase', { timeout: SLOW }, async () => {
    const { vault } = await createVault('right passphrase');
    expect(await unlockVault(vault, 'right passphrase')).not.toBeNull();
  });

  it('returns null for a wrong passphrase', { timeout: SLOW }, async () => {
    const { vault } = await createVault('right passphrase');
    expect(await unlockVault(vault, 'wrong passphrase')).toBeNull();
  });

  it('stores no plaintext passphrase anywhere in the vault', { timeout: SLOW }, async () => {
    const { vault } = await createVault('PASSPHRASE-MARKER');
    expect(JSON.stringify(vault)).not.toContain('PASSPHRASE-MARKER');
  });

  it('caches the derived key without writing it into the vault', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('pass');
    const exported = await exportKey(key);
    expect(JSON.stringify(vault)).not.toContain(exported);
  });

  it('round-trips an exported key', { timeout: SLOW }, async () => {
    const { key } = await createVault('pass');
    const reimported = await importKey(await exportKey(key));
    const record = await encryptSecret(key, 'value');
    expect(await decryptSecret(reimported, record)).toBe('value');
  });

  it('requires a passphrase', async () => {
    await expect(createVault('')).rejects.toThrow(/passphrase is required/);
  });
});

describe('validateVault', () => {
  it('accepts a freshly created vault', { timeout: SLOW }, async () => {
    const { vault } = await createVault('pass');
    expect(() => validateVault(vault)).not.toThrow();
  });

  it('rejects an absurdly low iteration count', { timeout: SLOW }, async () => {
    // A hostile imported vault claiming 1 iteration would make its own
    // passphrase trivially brute-forceable.
    const { vault } = await createVault('pass');
    expect(() => validateVault({ ...vault, iterations: 1 })).toThrow(/iteration count/);
  });

  it('rejects an absurdly high one, which would hang the browser', { timeout: SLOW }, async () => {
    const { vault } = await createVault('pass');
    expect(() => validateVault({ ...vault, iterations: 1e12 })).toThrow(/iteration count/);
  });

  it('rejects a vault with an unknown version or KDF', { timeout: SLOW }, async () => {
    const { vault } = await createVault('pass');
    expect(() => validateVault({ ...vault, version: 99 })).toThrow(/version/);
    expect(() => validateVault({ ...vault, kdf: 'scrypt' })).toThrow(/key derivation/);
  });

  it('rejects a missing vault', () => {
    expect(() => validateVault(null)).toThrow(/No vault/);
  });
});

describe('decryptOne', () => {
  it('needs a passphrase that really works, not a flag', { timeout: SLOW }, async () => {
    /* This is the reveal path. It re-derives from the supplied passphrase and
       never consults a cached key, so there is no boolean to patch out --
       a wrong passphrase produces a wrong key and AES-GCM refuses. */
    const { vault, key } = await createVault('the passphrase');
    const withSecret = putRecord(vault, 's1', await encryptSecret(key, 'Bearer revealed'));

    expect(await decryptOne(withSecret, 'the passphrase', 's1')).toEqual({
      ok: true,
      value: 'Bearer revealed',
    });
    expect(await decryptOne(withSecret, 'wrong', 's1')).toEqual({
      ok: false,
      error: 'decrypt-failed',
    });
  });

  it('reports a missing secret distinctly from a failed decrypt', { timeout: SLOW }, async () => {
    const { vault } = await createVault('pass');
    expect(await decryptOne(vault, 'pass', 'nope')).toEqual({ ok: false, error: 'no-such-secret' });
  });

  it('does not distinguish a wrong passphrase from a corrupt record', { timeout: SLOW }, async () => {
    // Telling them apart would tell an attacker which of the two they face.
    const { vault, key } = await createVault('pass');
    const good = putRecord(vault, 's1', await encryptSecret(key, 'value'));
    const corrupt = putRecord(vault, 's2', { ...good.records['s1']!, ciphertext: toB64(new Uint8Array(32)) });

    const wrongPass = await decryptOne(good, 'wrong', 's1');
    const badRecord = await decryptOne(corrupt, 'pass', 's2');
    expect(wrongPass).toEqual(badRecord);
  });
});

describe('decryptAll', () => {
  it('returns every value and names the ones that would not decrypt', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('pass');
    let v = putRecord(vault, 'a', await encryptSecret(key, 'value-a'));
    v = putRecord(v, 'b', await encryptSecret(key, 'value-b'));
    v = putRecord(v, 'bad', { ...v.records['a']!, ciphertext: toB64(new Uint8Array(32)) });

    const { values, corrupt } = await decryptAll(v, key);
    expect(values).toEqual({ a: 'value-a', b: 'value-b' });
    expect(corrupt).toEqual(['bad']);
  });
});

describe('changePassphrase', () => {
  it('re-encrypts every secret under the new key', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('old pass');
    const withSecrets = putRecord(vault, 's1', await encryptSecret(key, 'Bearer kept'));

    const result = await changePassphrase(withSecrets, 'old pass', 'new pass');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await unlockVault(result.vault, 'new pass')).not.toBeNull();
    expect(await unlockVault(result.vault, 'old pass')).toBeNull();
    expect(await decryptOne(result.vault, 'new pass', 's1')).toEqual({
      ok: true,
      value: 'Bearer kept',
    });
  });

  it('refuses without the current passphrase', { timeout: SLOW }, async () => {
    const { vault } = await createVault('old pass');
    expect(await changePassphrase(vault, 'wrong', 'new')).toEqual({
      ok: false,
      error: 'incorrect-passphrase',
    });
  });

  it('carries a corrupt record across rather than destroying it', { timeout: SLOW }, async () => {
    // One unreadable entry must not take the rest of the vault with it.
    const { vault, key } = await createVault('old pass');
    let v = putRecord(vault, 'good', await encryptSecret(key, 'kept'));
    v = putRecord(v, 'bad', { ...v.records['good']!, ciphertext: toB64(new Uint8Array(32)) });

    const result = await changePassphrase(v, 'old pass', 'new pass');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.corrupt).toEqual(['bad']);
    expect(Object.keys(result.vault.records).sort()).toEqual(['bad', 'good']);
  });

  it('uses a fresh salt, so the same passphrase yields a different key', { timeout: SLOW }, async () => {
    const { vault } = await createVault('same pass');
    const result = await changePassphrase(vault, 'same pass', 'same pass');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vault.salt).not.toBe(vault.salt);
  });
});

describe('record helpers', () => {
  it('do not mutate the vault they are given', { timeout: SLOW }, async () => {
    // The caller persists the returned object in one write, so an interrupted
    // save must leave the original intact.
    const { vault, key } = await createVault('pass');
    const record = await encryptSecret(key, 'value');

    const added = putRecord(vault, 's1', record);
    expect(vault.records).toEqual({});
    expect(added.records['s1']).toBeDefined();

    const removed = removeRecord(added, 's1');
    expect(added.records['s1']).toBeDefined();
    expect(removed.records['s1']).toBeUndefined();
  });
});
