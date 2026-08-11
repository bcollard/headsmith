/* The passphrase-encrypted credential vault.
 *
 * The two-tier credential-store design -- session-only, or a passphrase-
 * encrypted vault whose key lives only in session storage -- is OpenModHeader's
 * (MIT, (c) 2026 Shiva M). This implementation is not; see NOTICE.md.
 *
 * Web Crypto only, no dependencies. That is what forces PBKDF2 rather than
 * Argon2id: Argon2id resists a GPU far better, and getting it means shipping
 * WebAssembly into an extension whose entire pitch is that you can read what
 * it ships. The trade is recorded in SECURITY.md rather than buried.
 *
 * Nothing here touches storage or knows what a profile is. It takes a
 * passphrase and bytes and returns records.
 *
 * ## Records are bound to their name
 *
 * Every record is sealed with its secret id as AES-GCM *additional
 * authenticated data*. The id is not encrypted -- it is already a key in the
 * file -- but it is authenticated, so a record cannot be moved.
 *
 * This matters because a vault is a JSON file on disk that its owner can edit.
 * Without binding, swapping the ciphertext under `authorization-prod` with the
 * one under `x-debug-token` produces a vault that decrypts perfectly and sends
 * the wrong credential to the wrong host. The cipher cannot notice, because
 * both records are authentic -- they are simply in the wrong place. Naming
 * each record inside its own authentication tag makes that swap fail.
 *
 * ## The passphrase is verified by decryption, never by comparison
 *
 * `unlock` proves a passphrase by decrypting a verifier record. `readSecret`
 * re-derives the key from the passphrase it is given and never consults a
 * cached one. There is no boolean anywhere that says "the passphrase was
 * correct" and could therefore be patched to true: a wrong passphrase produces
 * a wrong key, and a wrong key fails authentication inside the cipher.
 */

export const VAULT_FORMAT = 1;

export const KDF = {
  algorithm: 'PBKDF2' as const,
  hash: 'SHA-256' as const,
  iterations: 600_000,
  saltBytes: 16,
  keyBits: 256,
};

export const CIPHER = {
  algorithm: 'AES-GCM' as const,
  ivBytes: 12,
  tagBits: 128,
};

/* Sealed under the AAD below to prove a passphrase without touching a real
   record, so an empty vault can still reject a wrong passphrase. */
const VERIFIER_AAD = 'headsmith:vault-verifier';
const VERIFIER_PLAINTEXT = 'ok';

/* Namespaced so a secret can never be named such that its AAD collides with
   the verifier's. */
const recordAad = (secretId: string) => `headsmith:secret:${secretId}`;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error('Web Crypto is unavailable in this context');
  return crypto.subtle;
}

export function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

export function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Validates before decoding. Vault files can be hand-edited or imported, so
   malformed input is an expected case: it fails here with a description of the
   field rather than somewhere deeper with a description of the bytes. The
   value itself is never echoed into the message. */
export function fromB64(
  value: unknown,
  options: { expectedBytes?: number; label?: string } = {},
): Uint8Array {
  const label = options.label ?? 'data';
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${label}: expected a base64 string`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Invalid ${label}: not well-formed base64`);
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Invalid ${label}: could not be decoded`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  if (options.expectedBytes !== undefined && bytes.length !== options.expectedBytes) {
    throw new Error(`Invalid ${label}: expected ${options.expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One encrypted value. Carries only what varies per record. */
export interface Sealed {
  readonly iv: string;
  readonly ct: string;
}

export interface KdfParams {
  readonly algorithm: string;
  readonly hash: string;
  readonly iterations: number;
  readonly salt: string;
}

export interface VaultFile {
  readonly format: number;
  /* Held once at the vault level rather than repeated on every record: all
     records share one key, so a per-record copy would be redundant state that
     can disagree with itself. */
  readonly kdf: KdfParams;
  readonly verifier: Sealed;
  readonly records: Readonly<Record<string, Sealed>>;
  readonly createdAt: number;
  readonly rotatedAt?: number;
}

// ---------------------------------------------------------------------------
// Keys and sealing
// ---------------------------------------------------------------------------

export async function deriveKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('A passphrase is required');
  }
  const salt = fromB64(params.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });

  const material = await subtle().importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);

  return subtle().deriveKey(
    {
      name: KDF.algorithm,
      salt: salt as BufferSource,
      iterations: params.iterations,
      hash: params.hash,
    },
    material,
    { name: CIPHER.algorithm, length: KDF.keyBits },
    /* Extractable, because the derived key is cached in storage.session so an
       MV3 worker can be suspended and revived without re-prompting. A
       non-extractable key cannot be cached at all, which would mean a 600,000
       iteration derivation on every wake-up. It is dropped on lock and never
       written to storage.local. */
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importKey(raw: string): Promise<CryptoKey> {
  const bytes = fromB64(raw, { expectedBytes: KDF.keyBits / 8, label: 'session key' });
  return subtle().importKey('raw', bytes as BufferSource, { name: CIPHER.algorithm }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/* Encrypts under `aad`, which is authenticated but not hidden. A fresh IV per
   call is what makes two encryptions of the same plaintext differ; reusing one
   under a single key breaks GCM catastrophically. */
export async function seal(key: CryptoKey, aad: string, plaintext: string): Promise<Sealed> {
  const iv = randomBytes(CIPHER.ivBytes);
  const ct = await subtle().encrypt(
    {
      name: CIPHER.algorithm,
      iv: iv as BufferSource,
      tagLength: CIPHER.tagBits,
      additionalData: utf8.encode(aad),
    },
    key,
    utf8.encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/* Returns null on any failure. A wrong key, a tampered ciphertext, a record
   moved to a different name and a malformed record are all authentication
   failures, all expected, and all reported identically -- distinguishing them
   would tell an attacker which of them they are looking at. No plaintext ever
   appears in anything thrown or returned here. */
export async function unseal(key: CryptoKey, aad: string, record: unknown): Promise<string | null> {
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    const sealed = assertSealed(record, 'record');
    iv = fromB64(sealed.iv, { expectedBytes: CIPHER.ivBytes, label: 'IV' });
    ct = fromB64(sealed.ct, { label: 'ciphertext' });
    // GCM output is at least the authentication tag.
    if (ct.length < CIPHER.tagBits / 8) return null;
  } catch {
    return null;
  }

  try {
    const plain = await subtle().decrypt(
      {
        name: CIPHER.algorithm,
        iv: iv as BufferSource,
        tagLength: CIPHER.tagBits,
        additionalData: utf8.encode(aad),
      },
      key,
      ct as BufferSource,
    );
    return fromUtf8.decode(plain);
  } catch {
    return null;
  }
}

function assertSealed(value: unknown, label: string): Sealed {
  if (!value || typeof value !== 'object') throw new Error(`Malformed ${label}`);
  const sealed = value as Partial<Sealed>;
  if (typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw new Error(`Malformed ${label}`);
  }
  return { iv: sealed.iv, ct: sealed.ct };
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

export async function createVault(
  passphrase: string,
  now: number = Date.now(),
): Promise<{ vault: VaultFile; key: CryptoKey }> {
  const kdf: KdfParams = {
    algorithm: KDF.algorithm,
    hash: KDF.hash,
    iterations: KDF.iterations,
    salt: toB64(randomBytes(KDF.saltBytes)),
  };
  const key = await deriveKey(passphrase, kdf);
  return {
    vault: {
      format: VAULT_FORMAT,
      kdf,
      verifier: await seal(key, VERIFIER_AAD, VERIFIER_PLAINTEXT),
      records: {},
      createdAt: now,
    },
    key,
  };
}

/* Structural validation, before any cryptography is attempted. */
export function assertVaultFile(value: unknown): asserts value is VaultFile {
  if (!value || typeof value !== 'object') throw new Error('No vault present');
  const vault = value as Partial<VaultFile>;

  if (vault.format !== VAULT_FORMAT) throw new Error(`Unsupported vault format: ${vault.format}`);
  if (!vault.kdf || typeof vault.kdf !== 'object') throw new Error('Vault has no key parameters');
  if (vault.kdf.algorithm !== KDF.algorithm) throw new Error('Unsupported key derivation');
  if (vault.kdf.hash !== KDF.hash) throw new Error('Unsupported hash');

  /* Bounded on both sides. A vault claiming one iteration would make its own
     passphrase trivially cheap to attack; one claiming a billion would hang
     the browser on unlock. An imported file does not get to choose either. */
  const { iterations } = vault.kdf;
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) {
    throw new Error('Unsupported iteration count');
  }

  fromB64(vault.kdf.salt, { expectedBytes: KDF.saltBytes, label: 'salt' });
  assertSealed(vault.verifier, 'verifier');
  if (vault.records !== undefined && (typeof vault.records !== 'object' || vault.records === null)) {
    throw new Error('Malformed records');
  }
}

/* Derives the key and proves it against the verifier. Returns null for a wrong
   passphrase so callers can distinguish that from a structurally broken vault,
   which throws. */
export async function unlockVault(vault: unknown, passphrase: string): Promise<CryptoKey | null> {
  assertVaultFile(vault);
  const key = await deriveKey(passphrase, vault.kdf);
  const proof = await unseal(key, VERIFIER_AAD, vault.verifier);
  return proof === VERIFIER_PLAINTEXT ? key : null;
}

export async function readSecret(
  vault: VaultFile,
  key: CryptoKey,
  secretId: string,
): Promise<string | null> {
  const record = vault.records[secretId];
  if (!record) return null;
  return unseal(key, recordAad(secretId), record);
}

/* The reveal path. Takes a passphrase and does real work with it: the key is
   re-derived from the vault's own salt and used to authenticate that one
   record. It never reads a cached key, so removing the prompt from the UI does
   not produce a value. */
export async function readSecretWithPassphrase(
  vault: unknown,
  passphrase: string,
  secretId: string,
): Promise<{ ok: true; value: string } | { ok: false; error: 'no-such-secret' | 'decrypt-failed' }> {
  assertVaultFile(vault);
  if (!vault.records[secretId]) return { ok: false, error: 'no-such-secret' };

  const key = await deriveKey(passphrase, vault.kdf);
  const value = await readSecret(vault, key, secretId);
  return value === null ? { ok: false, error: 'decrypt-failed' } : { ok: true, value };
}

export async function readAll(
  vault: VaultFile,
  key: CryptoKey,
): Promise<{ values: Record<string, string>; unreadable: string[] }> {
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const secretId of Object.keys(vault.records)) {
    const value = await readSecret(vault, key, secretId);
    if (value === null) unreadable.push(secretId);
    else values[secretId] = value;
  }
  return { values, unreadable };
}

/* Writers return a new vault rather than mutating. The caller persists the
   result in one write, so an interrupted save leaves the original intact
   instead of a half-updated file. */
export async function writeSecret(
  vault: VaultFile,
  key: CryptoKey,
  secretId: string,
  value: string,
): Promise<VaultFile> {
  const sealed = await seal(key, recordAad(secretId), value);
  return { ...vault, records: { ...vault.records, [secretId]: sealed } };
}

export function forgetSecret(vault: VaultFile, secretId: string): VaultFile {
  if (!(secretId in vault.records)) return vault;
  const records = { ...vault.records };
  delete records[secretId];
  return { ...vault, records };
}

/* Rebuilds the vault under a new passphrase, with a fresh salt so the same
   passphrase would not produce the same key twice. */
export async function rekeyVault(
  vault: unknown,
  currentPassphrase: string,
  nextPassphrase: string,
  now: number = Date.now(),
): Promise<
  { ok: true; vault: VaultFile; key: CryptoKey; unreadable: string[] } | { ok: false; error: string }
> {
  const currentKey = await unlockVault(vault, currentPassphrase);
  if (!currentKey) return { ok: false, error: 'incorrect-passphrase' };

  assertVaultFile(vault);
  const { values, unreadable } = await readAll(vault, currentKey);

  const kdf: KdfParams = {
    algorithm: KDF.algorithm,
    hash: KDF.hash,
    iterations: KDF.iterations,
    salt: toB64(randomBytes(KDF.saltBytes)),
  };
  const key = await deriveKey(nextPassphrase, kdf);

  const records: Record<string, Sealed> = {};
  for (const [secretId, value] of Object.entries(values)) {
    records[secretId] = await seal(key, recordAad(secretId), value);
  }
  /* Records that would not decrypt are carried over untouched. One damaged
     entry must not destroy the rest of the vault, and re-encrypting a value we
     could not read is not possible anyway. */
  for (const secretId of unreadable) {
    records[secretId] = vault.records[secretId]!;
  }

  return {
    ok: true,
    unreadable,
    key,
    vault: {
      format: VAULT_FORMAT,
      kdf,
      verifier: await seal(key, VERIFIER_AAD, VERIFIER_PLAINTEXT),
      records,
      createdAt: vault.createdAt,
      rotatedAt: now,
    },
  };
}
