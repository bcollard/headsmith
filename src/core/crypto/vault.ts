/* The passphrase-encrypted credential vault.
 *
 * Derived from OpenModHeader's chromium/vault.js.
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * This is a close port: the function set, the KDF and cipher parameters, the
 * check-sentinel design and the null-on-authentication-failure contract are
 * all from upstream. Changes are noted in NOTICE.md.
 *
 * AES-GCM secrets under a key derived from the user's passphrase with
 * PBKDF2-SHA256. Browser-native Web Crypto throughout; no dependencies, which
 * is why the KDF is PBKDF2 rather than Argon2id. That trade is recorded in
 * SECURITY.md rather than hidden: Argon2id would resist a GPU better, and
 * getting it would mean shipping WASM into an extension whose entire pitch is
 * that you can read what it ships.
 *
 * Nothing here touches storage or knows what a profile is. It takes bytes and
 * a passphrase and returns records, so it is testable without a browser and
 * cannot accidentally learn where ciphertext lives.
 *
 * Two design points worth stating, because both are easy to get subtly wrong:
 *
 * - Every record carries the KDF parameters it was written with. Raising the
 *   iteration count later must not orphan existing vaults, so unlock reads the
 *   count from the record rather than from the current constant.
 *
 * - `decryptOne` re-derives the key from a supplied passphrase and never
 *   consults a cached one. There is no boolean "was the passphrase correct" to
 *   patch out: a wrong passphrase yields a wrong key, and a wrong key fails
 *   AES-GCM authentication inside the cipher. That is what makes the reveal
 *   prompt a real check rather than a speed bump.
 */

export const VAULT_FORMAT_VERSION = 1;

export const KDF = {
  name: 'PBKDF2' as const,
  hash: 'SHA-256' as const,
  iterations: 600_000,
  saltBytes: 16,
  keyBits: 256,
};

export const CIPHER = {
  name: 'AES-GCM' as const,
  ivBytes: 12,
  tagBits: 128,
};

/* Decrypting this constant proves the passphrase is right, so a wrong one is
   detected once at unlock rather than separately per secret. */
const CHECK_PLAINTEXT = 'headsmith-vault-check-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Web Crypto is unavailable in this context');
  return c.subtle;
}

export function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Base64 with validation
// ---------------------------------------------------------------------------

export function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Throws on anything not well-formed. Callers validate before handing data to
   decrypt, so a malformed or hostile imported record fails early with a
   generic message rather than somewhere deeper with a specific one. */
export function fromB64(
  value: unknown,
  options: { expectedBytes?: number; label?: string } = {},
): Uint8Array {
  const label = options.label ?? 'data';
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${label}: not a string`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid ${label}: not valid base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Invalid ${label}: could not decode`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (options.expectedBytes != null && out.length !== options.expectedBytes) {
    throw new Error(`Invalid ${label}: expected ${options.expectedBytes} bytes, got ${out.length}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = KDF.iterations,
): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('A passphrase is required');

  const material = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);

  return subtle().deriveKey(
    { name: KDF.name, salt: salt as BufferSource, iterations, hash: KDF.hash },
    material,
    { name: CIPHER.name, length: KDF.keyBits },
    /* Extractable, because the derived key is cached in storage.session so an
       MV3 service worker can be suspended and revived without re-prompting.
       It is removed on lock and never written to storage.local. The
       alternative -- a non-extractable key -- cannot be cached at all, which
       would mean a PBKDF2 run at 600k iterations on every worker wake-up. */
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importKey(rawB64: string): Promise<CryptoKey> {
  const raw = fromB64(rawB64, { expectedBytes: KDF.keyBits / 8, label: 'session key' });
  return subtle().importKey('raw', raw as BufferSource, { name: CIPHER.name }, true, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface SecretRecord {
  version: number;
  algorithm: string;
  kdf: string;
  iterations: number;
  iv: string;
  ciphertext: string;
}

export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<SecretRecord> {
  /* A fresh IV per encryption is what makes two encryptions of the same
     plaintext produce different ciphertext. Reusing one under a key breaks
     AES-GCM catastrophically -- it leaks the XOR of the plaintexts and the
     authentication subkey. */
  const iv = randomBytes(CIPHER.ivBytes);
  const ct = await subtle().encrypt(
    { name: CIPHER.name, iv: iv as BufferSource, tagLength: CIPHER.tagBits },
    key,
    encoder.encode(plaintext ?? ''),
  );
  return {
    version: VAULT_FORMAT_VERSION,
    algorithm: CIPHER.name,
    kdf: KDF.name,
    iterations: KDF.iterations,
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ct)),
  };
}

export function validateRecord(record: unknown): { iv: Uint8Array; ct: Uint8Array } {
  if (!record || typeof record !== 'object') throw new Error('Malformed secret record');
  const r = record as Partial<SecretRecord>;
  if (r.version !== VAULT_FORMAT_VERSION) throw new Error(`Unsupported record version: ${r.version}`);
  if (r.algorithm !== CIPHER.name) throw new Error('Unsupported cipher');
  if (r.kdf !== KDF.name) throw new Error('Unsupported key derivation');
  const iv = fromB64(r.iv, { expectedBytes: CIPHER.ivBytes, label: 'IV' });
  const ct = fromB64(r.ciphertext, { label: 'ciphertext' });
  // AES-GCM output is at least the authentication tag.
  if (ct.length < CIPHER.tagBits / 8) throw new Error('Ciphertext too short to be authentic');
  return { iv, ct };
}

/* Returns null rather than throwing on an authentication failure: a wrong key
   or a tampered record is an expected condition, not a crash. No plaintext
   ever appears in an error raised here. */
export async function decryptSecret(key: CryptoKey, record: unknown): Promise<string | null> {
  let parts: { iv: Uint8Array; ct: Uint8Array };
  try {
    parts = validateRecord(record);
  } catch {
    return null;
  }
  try {
    const buf = await subtle().decrypt(
      { name: CIPHER.name, iv: parts.iv as BufferSource, tagLength: CIPHER.tagBits },
      key,
      parts.ct as BufferSource,
    );
    return decoder.decode(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

export interface Vault {
  version: number;
  kdf: string;
  hash: string;
  iterations: number;
  salt: string;
  check: SecretRecord;
  records: Record<string, SecretRecord>;
  createdAt: number;
  rotatedAt?: number;
}

export async function createVault(
  passphrase: string,
  now: number = Date.now(),
): Promise<{ vault: Vault; key: CryptoKey }> {
  const salt = randomBytes(KDF.saltBytes);
  const key = await deriveKey(passphrase, salt);
  const check = await encryptSecret(key, CHECK_PLAINTEXT);
  return {
    vault: {
      version: VAULT_FORMAT_VERSION,
      kdf: KDF.name,
      hash: KDF.hash,
      iterations: KDF.iterations,
      salt: toB64(salt),
      check,
      records: {},
      createdAt: now,
    },
    key,
  };
}

export function validateVault(vault: unknown): asserts vault is Vault {
  if (!vault || typeof vault !== 'object') throw new Error('No vault present');
  const v = vault as Partial<Vault>;
  if (v.version !== VAULT_FORMAT_VERSION) throw new Error(`Unsupported vault version: ${v.version}`);
  if (v.kdf !== KDF.name) throw new Error('Unsupported key derivation');
  const iterations = Number(v.iterations);
  /* A hostile vault claiming one iteration would make its own passphrase
     trivially brute-forceable; one claiming a billion would hang the browser.
     Both are rejected rather than honoured. */
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) {
    throw new Error('Unsupported iteration count');
  }
  fromB64(v.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  validateRecord(v.check);
  if (v.records && typeof v.records !== 'object') throw new Error('Malformed records');
}

/* Derives the key and verifies it against the check value. Returns null for a
   wrong passphrase so callers can tell that apart from a broken vault. */
export async function unlockVault(vault: unknown, passphrase: string): Promise<CryptoKey | null> {
  validateVault(vault);
  const salt = fromB64(vault.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  const key = await deriveKey(passphrase, salt, vault.iterations);
  const check = await decryptSecret(key, vault.check);
  return check === CHECK_PLAINTEXT ? key : null;
}

/* Decrypts one record straight from the ciphertext, using a key derived from
   the supplied passphrase. Deliberately takes no cached state -- see the note
   at the top of the file about why this shape matters. */
export async function decryptOne(
  vault: unknown,
  passphrase: string,
  secretId: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  validateVault(vault);
  const record = vault.records?.[secretId];
  if (!record) return { ok: false, error: 'no-such-secret' };

  const salt = fromB64(vault.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  const key = await deriveKey(passphrase, salt, vault.iterations);
  const value = await decryptSecret(key, record);

  /* A wrong passphrase and a corrupt record both fail authentication and are
     reported identically -- distinguishing them would tell an attacker which
     of the two they are looking at. */
  if (value == null) return { ok: false, error: 'decrypt-failed' };
  return { ok: true, value };
}

export async function decryptAll(
  vault: Vault,
  key: CryptoKey,
): Promise<{ values: Record<string, string>; corrupt: string[] }> {
  const values: Record<string, string> = {};
  const corrupt: string[] = [];
  for (const [secretId, record] of Object.entries(vault.records ?? {})) {
    const value = await decryptSecret(key, record);
    if (value == null) corrupt.push(secretId);
    else values[secretId] = value;
  }
  return { values, corrupt };
}

/* Rebuilds the whole vault under a new passphrase. The caller persists the
   result in one write, so an interrupted rotation leaves the original vault
   intact rather than a half-migrated one. */
export async function changePassphrase(
  vault: unknown,
  currentPassphrase: string,
  nextPassphrase: string,
  now: number = Date.now(),
): Promise<
  { ok: true; vault: Vault; key: CryptoKey; corrupt: string[] } | { ok: false; error: string }
> {
  const currentKey = await unlockVault(vault, currentPassphrase);
  if (!currentKey) return { ok: false, error: 'incorrect-passphrase' };

  validateVault(vault);
  const { values, corrupt } = await decryptAll(vault, currentKey);

  const salt = randomBytes(KDF.saltBytes);
  const key = await deriveKey(nextPassphrase, salt);
  const check = await encryptSecret(key, CHECK_PLAINTEXT);

  const records: Record<string, SecretRecord> = {};
  for (const [secretId, value] of Object.entries(values)) {
    records[secretId] = await encryptSecret(key, value);
  }
  /* Records that would not decrypt are carried across untouched rather than
     dropped, so one corrupt entry cannot destroy the rest of the vault. */
  for (const secretId of corrupt) {
    records[secretId] = vault.records[secretId]!;
  }

  return {
    ok: true,
    corrupt,
    key,
    vault: {
      version: VAULT_FORMAT_VERSION,
      kdf: KDF.name,
      hash: KDF.hash,
      iterations: KDF.iterations,
      salt: toB64(salt),
      check,
      records,
      createdAt: vault.createdAt,
      rotatedAt: now,
    },
  };
}

export function putRecord(vault: Vault, secretId: string, record: SecretRecord): Vault {
  return { ...vault, records: { ...vault.records, [secretId]: record } };
}

export function removeRecord(vault: Vault, secretId: string): Vault {
  const records = { ...vault.records };
  delete records[secretId];
  return { ...vault, records };
}
