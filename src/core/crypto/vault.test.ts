import { describe, it, expect } from 'vitest';
import {
  createVault,
  unlockVault,
  readSecret,
  readSecretWithPassphrase,
  readAll,
  writeSecret,
  forgetSecret,
  rekeyVault,
  assertVaultFile,
  seal,
  unseal,
  deriveKey,
  exportKey,
  importKey,
  toB64,
  fromB64,
  KDF,
  CIPHER,
  type VaultFile,
} from './vault';

/* PBKDF2 at 600,000 iterations costs roughly half a second, which is the
   point of it. Tests that need a key derive one and reuse it. */
const SLOW = 30_000;
const PASS = 'a sufficiently long vault passphrase';

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it('rejects anything not well-formed', () => {
    for (const bad of ['', 'not base64!', 'abc', '****', null, undefined, 42, {}]) {
      expect(() => fromB64(bad)).toThrow();
    }
  });

  it('rejects a value of the wrong length', () => {
    expect(() => fromB64(toB64(new Uint8Array(8)), { expectedBytes: 16 })).toThrow(/expected 16/);
  });

  it('names the field without echoing the value', () => {
    // These strings reach the UI, so they must not carry key material.
    expect(() => fromB64('!!!!', { label: 'session key' })).toThrow(/session key/);
  });
});

describe('seal and unseal', () => {
  it('round-trips under a matching AAD', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    const sealed = await seal(key, 'aad-a', 'Bearer abc123');
    expect(await unseal(key, 'aad-a', sealed)).toBe('Bearer abc123');
  });

  it('refuses a different AAD', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    const sealed = await seal(key, 'aad-a', 'value');
    expect(await unseal(key, 'aad-b', sealed)).toBeNull();
  });

  it('produces different ciphertext for the same plaintext', { timeout: SLOW }, async () => {
    // A fresh IV per call. Reuse under one key breaks GCM catastrophically.
    const { key } = await createVault(PASS);
    const a = await seal(key, 'aad', 'same value');
    const b = await seal(key, 'aad', 'same value');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('never stores the plaintext in the record', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    const sealed = await seal(key, 'aad', 'SECRET-MARKER-VALUE');
    expect(JSON.stringify(sealed)).not.toContain('SECRET-MARKER-VALUE');
  });

  it('returns null rather than throwing on a wrong key', { timeout: SLOW }, async () => {
    const a = await createVault(PASS);
    const b = await createVault('a different passphrase entirely');
    const sealed = await seal(a.key, 'aad', 'value');
    expect(await unseal(b.key, 'aad', sealed)).toBeNull();
  });

  it('returns null on a tampered ciphertext', { timeout: SLOW }, async () => {
    // GCM authenticates: a flipped bit must fail, not decrypt to garbage that
    // then gets sent as a header value.
    const { key } = await createVault(PASS);
    const sealed = await seal(key, 'aad', 'value');
    const bytes = fromB64(sealed.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(await unseal(key, 'aad', { ...sealed, ct: toB64(bytes) })).toBeNull();
  });

  it('returns null on a malformed record instead of crashing', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    for (const bad of [null, {}, { iv: 1, ct: 2 }, { iv: '!!', ct: '!!' }, 'nope']) {
      expect(await unseal(key, 'aad', bad)).toBeNull();
    }
  });

  it('returns null on a ciphertext too short to carry a tag', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    expect(
      await unseal(key, 'aad', { iv: toB64(new Uint8Array(CIPHER.ivBytes)), ct: toB64(new Uint8Array(4)) }),
    ).toBeNull();
  });
});

describe('records are bound to their name', () => {
  /* The reason AAD is used at all. A vault is a JSON file its owner can edit;
     without binding, swapping two ciphertexts produces a file that decrypts
     perfectly and sends the wrong credential to the wrong host. */
  it('refuses a record moved to a different secret id', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault(PASS);
    let v = await writeSecret(vault, key, 'prod-token', 'PRODUCTION-CREDENTIAL');
    v = await writeSecret(v, key, 'debug-token', 'harmless');

    // Swap the two ciphertexts, exactly as a hand edit would.
    const swapped: VaultFile = {
      ...v,
      records: {
        'prod-token': v.records['debug-token']!,
        'debug-token': v.records['prod-token']!,
      },
    };

    expect(await readSecret(swapped, key, 'prod-token')).toBeNull();
    expect(await readSecret(swapped, key, 'debug-token')).toBeNull();
  });

  it('reads each record correctly when they are where they belong', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault(PASS);
    let v = await writeSecret(vault, key, 'prod-token', 'PRODUCTION-CREDENTIAL');
    v = await writeSecret(v, key, 'debug-token', 'harmless');

    expect(await readSecret(v, key, 'prod-token')).toBe('PRODUCTION-CREDENTIAL');
    expect(await readSecret(v, key, 'debug-token')).toBe('harmless');
  });

  it('will not accept the verifier as a secret record', { timeout: SLOW }, async () => {
    // The verifier's AAD is namespaced away from every possible secret id, so
    // it cannot be promoted into a record that decrypts.
    const { vault, key } = await createVault(PASS);
    const forged: VaultFile = { ...vault, records: { anything: vault.verifier } };
    expect(await readSecret(forged, key, 'anything')).toBeNull();
  });
});

describe('vault lifecycle', () => {
  it('unlocks with the right passphrase and not a wrong one', { timeout: SLOW }, async () => {
    const { vault } = await createVault(PASS);
    expect(await unlockVault(vault, PASS)).not.toBeNull();
    expect(await unlockVault(vault, 'wrong passphrase')).toBeNull();
  });

  it('rejects a wrong passphrase even when the vault is empty', { timeout: SLOW }, async () => {
    // The verifier exists so this is possible without a record to try.
    const { vault } = await createVault(PASS);
    expect(Object.keys(vault.records)).toHaveLength(0);
    expect(await unlockVault(vault, 'wrong')).toBeNull();
  });

  it('stores no passphrase and no key anywhere in the file', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('PASSPHRASE-MARKER');
    const serialised = JSON.stringify(vault);
    expect(serialised).not.toContain('PASSPHRASE-MARKER');
    expect(serialised).not.toContain(await exportKey(key));
  });

  it('round-trips an exported key', { timeout: SLOW }, async () => {
    const { key } = await createVault(PASS);
    const reimported = await importKey(await exportKey(key));
    const sealed = await seal(key, 'aad', 'value');
    expect(await unseal(reimported, 'aad', sealed)).toBe('value');
  });

  it('requires a passphrase', async () => {
    await expect(createVault('')).rejects.toThrow(/passphrase is required/);
  });
});

describe('assertVaultFile', () => {
  it('accepts a freshly created vault', { timeout: SLOW }, async () => {
    const { vault } = await createVault(PASS);
    expect(() => assertVaultFile(vault)).not.toThrow();
  });

  it('bounds the iteration count on both sides', { timeout: SLOW }, async () => {
    /* An imported vault claiming 1 iteration would make its own passphrase
       trivially cheap to attack; one claiming a billion would hang the browser
       on unlock. Neither is the file's choice to make. */
    const { vault } = await createVault(PASS);
    expect(() => assertVaultFile({ ...vault, kdf: { ...vault.kdf, iterations: 1 } })).toThrow(
      /iteration count/,
    );
    expect(() => assertVaultFile({ ...vault, kdf: { ...vault.kdf, iterations: 1e12 } })).toThrow(
      /iteration count/,
    );
  });

  it('rejects an unknown format, algorithm or hash', { timeout: SLOW }, async () => {
    const { vault } = await createVault(PASS);
    expect(() => assertVaultFile({ ...vault, format: 99 })).toThrow(/format/);
    expect(() => assertVaultFile({ ...vault, kdf: { ...vault.kdf, algorithm: 'scrypt' } })).toThrow(
      /key derivation/,
    );
    expect(() => assertVaultFile({ ...vault, kdf: { ...vault.kdf, hash: 'MD5' } })).toThrow(/hash/);
  });

  it('rejects a missing or malformed vault', () => {
    expect(() => assertVaultFile(null)).toThrow(/No vault/);
    expect(() => assertVaultFile({ format: 1 })).toThrow(/key parameters/);
  });
});

describe('readSecretWithPassphrase', () => {
  it('needs a passphrase that really works, not a flag', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault(PASS);
    const v = await writeSecret(vault, key, 's1', 'Bearer revealed');

    expect(await readSecretWithPassphrase(v, PASS, 's1')).toEqual({
      ok: true,
      value: 'Bearer revealed',
    });
    expect(await readSecretWithPassphrase(v, 'wrong', 's1')).toEqual({
      ok: false,
      error: 'decrypt-failed',
    });
  });

  it('reports a missing secret distinctly from a failed decrypt', { timeout: SLOW }, async () => {
    const { vault } = await createVault(PASS);
    expect(await readSecretWithPassphrase(vault, PASS, 'nope')).toEqual({
      ok: false,
      error: 'no-such-secret',
    });
  });

  it('does not distinguish a wrong passphrase from a damaged record', { timeout: SLOW }, async () => {
    // Telling them apart would tell an attacker which they are facing.
    const { vault, key } = await createVault(PASS);
    const good = await writeSecret(vault, key, 's1', 'value');
    const damaged: VaultFile = {
      ...good,
      records: { ...good.records, s2: { ...good.records['s1']!, ct: toB64(new Uint8Array(32)) } },
    };

    expect(await readSecretWithPassphrase(good, 'wrong', 's1')).toEqual(
      await readSecretWithPassphrase(damaged, PASS, 's2'),
    );
  });
});

describe('readAll', () => {
  it('returns every value and names the ones that would not decrypt', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault(PASS);
    let v = await writeSecret(vault, key, 'a', 'value-a');
    v = await writeSecret(v, key, 'b', 'value-b');
    v = { ...v, records: { ...v.records, bad: { ...v.records['a']!, ct: toB64(new Uint8Array(32)) } } };

    const { values, unreadable } = await readAll(v, key);
    expect(values).toEqual({ a: 'value-a', b: 'value-b' });
    expect(unreadable).toEqual(['bad']);
  });
});

describe('writers do not mutate', () => {
  it('leaves the original vault untouched', { timeout: SLOW }, async () => {
    /* The caller persists the result in one write, so an interrupted save must
       leave the original intact rather than a half-updated file. */
    const { vault, key } = await createVault(PASS);

    const added = await writeSecret(vault, key, 's1', 'value');
    expect(vault.records).toEqual({});
    expect(added.records['s1']).toBeDefined();

    const removed = forgetSecret(added, 's1');
    expect(added.records['s1']).toBeDefined();
    expect(removed.records['s1']).toBeUndefined();
  });

  it('returns the same vault when forgetting something absent', { timeout: SLOW }, async () => {
    const { vault } = await createVault(PASS);
    expect(forgetSecret(vault, 'nothing')).toBe(vault);
  });
});

describe('rekeyVault', () => {
  it('re-encrypts every secret under the new passphrase', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('old passphrase');
    const withSecret = await writeSecret(vault, key, 's1', 'Bearer kept');

    const result = await rekeyVault(withSecret, 'old passphrase', 'new passphrase');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await unlockVault(result.vault, 'new passphrase')).not.toBeNull();
    expect(await unlockVault(result.vault, 'old passphrase')).toBeNull();
    expect(await readSecretWithPassphrase(result.vault, 'new passphrase', 's1')).toEqual({
      ok: true,
      value: 'Bearer kept',
    });
  });

  it('keeps records bound to their names across a rekey', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('old passphrase');
    let v = await writeSecret(vault, key, 'prod', 'PRODUCTION');
    v = await writeSecret(v, key, 'dev', 'development');

    const result = await rekeyVault(v, 'old passphrase', 'new passphrase');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const swapped: VaultFile = {
      ...result.vault,
      records: { prod: result.vault.records['dev']!, dev: result.vault.records['prod']! },
    };
    expect(await readSecret(swapped, result.key, 'prod')).toBeNull();
  });

  it('refuses without the current passphrase', { timeout: SLOW }, async () => {
    const { vault } = await createVault('old passphrase');
    expect(await rekeyVault(vault, 'wrong', 'new')).toEqual({
      ok: false,
      error: 'incorrect-passphrase',
    });
  });

  it('carries a damaged record across rather than destroying it', { timeout: SLOW }, async () => {
    const { vault, key } = await createVault('old passphrase');
    const good = await writeSecret(vault, key, 'good', 'kept');
    const withDamage: VaultFile = {
      ...good,
      records: { ...good.records, bad: { ...good.records['good']!, ct: toB64(new Uint8Array(32)) } },
    };

    const result = await rekeyVault(withDamage, 'old passphrase', 'new passphrase');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.unreadable).toEqual(['bad']);
    expect(Object.keys(result.vault.records).sort()).toEqual(['bad', 'good']);
  });

  it('uses a fresh salt, so the same passphrase yields a different key', { timeout: SLOW }, async () => {
    const { vault } = await createVault('same passphrase');
    const result = await rekeyVault(vault, 'same passphrase', 'same passphrase');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vault.kdf.salt).not.toBe(vault.kdf.salt);
  });
});

describe('key derivation parameters', () => {
  it('uses the documented cost', () => {
    // Changing this is a security decision, not a tuning one, so it is pinned.
    expect(KDF.iterations).toBe(600_000);
    expect(KDF.hash).toBe('SHA-256');
    expect(KDF.keyBits).toBe(256);
    expect(CIPHER.tagBits).toBe(128);
  });

  it('derives different keys from different salts', { timeout: SLOW }, async () => {
    const a = await deriveKey(PASS, {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 100_000,
      salt: toB64(new Uint8Array(KDF.saltBytes).fill(1)),
    });
    const b = await deriveKey(PASS, {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 100_000,
      salt: toB64(new Uint8Array(KDF.saltBytes).fill(2)),
    });
    expect(await exportKey(a)).not.toBe(await exportKey(b));
  });
});
