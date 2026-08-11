/* Credential storage, in the two modes Headsmith offers.
 *
 * Derived from OpenModHeader's chromium/secretstore.js.
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * Close port. The storage-area split, the public surface and the auto-lock
 * design are upstream's; the third storage mode is deliberately absent and
 * unlock throttling is new. See NOTICE.md.
 *
 *   session   values live in storage.session and nothing touches disk. The
 *             cost is retyping after a browser restart. This is the default.
 *   vault     values are AES-GCM encrypted in storage.local under a key
 *             derived from a passphrase; the key lives in storage.session and
 *             is dropped on lock.
 *
 * There is deliberately no third mode. OpenModHeader offers persistent
 * plaintext, and it is the only path by which a credential reaches disk
 * unencrypted -- keeping it would have made the plaintext-secret guard
 * unwritable without carving out an exception, and an exception in that guard
 * is the guard.
 *
 * Ciphertext and non-sensitive config go to storage.local. Decrypted values
 * and key material go to storage.session and nowhere else.
 */

import {
  changePassphrase,
  createVault,
  decryptAll,
  decryptOne,
  encryptSecret,
  exportKey,
  importKey,
  putRecord,
  removeRecord,
  unlockVault,
  validateVault,
  type Vault,
} from '../core/crypto/vault';
import { alarms, local, session } from '../platform/chrome';
import type { CredentialMode, Settings } from '../core/schema';

export const LOCAL_KEYS = { vault: 'vault' } as const;
export const SESSION_KEYS = {
  values: 'secretValues',
  key: 'vaultKey',
  lockAt: 'vaultLockAt',
  failures: 'unlockFailures',
} as const;

export const LOCK_ALARM = 'headsmith-vault-lock';

/* Unlock throttling. PBKDF2 at 600k iterations already costs roughly half a
   second, which is the real defence; this makes the cost explicit and stops a
   script from grinding through a list at whatever rate the machine allows.
   State lives in storage.session, so it resets on browser restart -- that is
   acceptable: a restart is not cheaper for an attacker than waiting. */
const MAX_FREE_ATTEMPTS = 5;
const BACKOFF_MS = 2000;

// ---------------------------------------------------------------------------
// Session value cache
// ---------------------------------------------------------------------------

async function getSessionValues(): Promise<Record<string, string>> {
  const values = await session.get<Record<string, string>>(SESSION_KEYS.values);
  return values && typeof values === 'object' ? values : {};
}

async function setSessionValues(values: Record<string, string>): Promise<boolean> {
  return session.set(SESSION_KEYS.values, values);
}

// ---------------------------------------------------------------------------
// Vault state
// ---------------------------------------------------------------------------

export async function getVault(): Promise<Vault | null> {
  return (await local.get<Vault>(LOCAL_KEYS.vault)) ?? null;
}

export async function vaultExists(): Promise<boolean> {
  return (await getVault()) !== null;
}

export async function isUnlocked(): Promise<boolean> {
  return Boolean(await session.get<string>(SESSION_KEYS.key));
}

async function activeKey(): Promise<CryptoKey | null> {
  const raw = await session.get<string>(SESSION_KEYS.key);
  if (!raw) return null;
  try {
    return await importKey(raw);
  } catch {
    return null;
  }
}

export async function initVault(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  const { vault, key } = await createVault(passphrase);
  await local.set(LOCAL_KEYS.vault, vault);
  const stored = await session.set(SESSION_KEYS.key, await exportKey(key));
  if (!stored) return { ok: false, error: 'no-session-storage' };
  /* Any credentials already held in session mode are left alone. Creating a
     vault is not the same act as switching to it -- switchMode is what moves
     values across, and it can only do that if they are still here. Clearing
     them here would silently discard everything a session-mode user had
     entered the moment they set a passphrase. */
  return { ok: true };
}

export type UnlockResult =
  | { ok: true; corrupt: string[] }
  | { ok: false; error: string; retryAfterMs?: number };

export async function unlock(passphrase: string, settings: Settings): Promise<UnlockResult> {
  const failures = (await session.get<number>(SESSION_KEYS.failures)) ?? 0;
  if (failures >= MAX_FREE_ATTEMPTS) {
    /* Linear rather than exponential: this is a speed bump against scripted
       guessing, and an exponential curve would eventually lock out a user who
       simply mistyped a long passphrase several times. */
    const wait = (failures - MAX_FREE_ATTEMPTS + 1) * BACKOFF_MS;
    await delay(wait);
  }

  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  let key: CryptoKey | null;
  try {
    key = await unlockVault(vault, passphrase);
  } catch (err) {
    return { ok: false, error: 'damaged-vault', ...detail(err) };
  }

  if (!key) {
    await session.set(SESSION_KEYS.failures, failures + 1);
    return { ok: false, error: 'incorrect-passphrase' };
  }

  /* Only the derived key is cached. Plaintext credentials are never mirrored
     into session storage in vault mode, so unlocking does not leave a readable
     dump of every credential sitting in a storage area. */
  const stored = await session.set(SESSION_KEYS.key, await exportKey(key));
  if (!stored) return { ok: false, error: 'no-session-storage' };

  await session.remove(SESSION_KEYS.failures);
  const { corrupt } = await decryptAll(vault, key);
  await noteActivity(settings);
  return { ok: true, corrupt };
}

/* Clears every trace of the unlocked state. Ciphertext in storage.local and
   all non-sensitive configuration are untouched. */
export async function lock(): Promise<void> {
  await session.remove([SESSION_KEYS.values, SESSION_KEYS.key, SESSION_KEYS.lockAt]);
  await alarms.clear(LOCK_ALARM);
}

export async function resetVault(): Promise<void> {
  await lock();
  await local.remove(LOCAL_KEYS.vault);
}

// ---------------------------------------------------------------------------
// Reading and writing secrets
// ---------------------------------------------------------------------------

/* The one place credentials are resolved for rule building. Returns a plain
   map so the compiler can be handed a synchronous resolver. */
export async function resolveSecrets(settings: Settings): Promise<Record<string, string>> {
  if (settings.credentialStorage === 'vault') {
    /* Decrypted on demand from ciphertext using the cached key. PBKDF2 is not
       re-run here -- only the AES-GCM step, which is cheap enough to do on
       every rule build. */
    const key = await activeKey();
    if (!key) return {};
    const vault = await getVault();
    if (!vault) return {};
    const { values } = await decryptAll(vault, key);
    return values;
  }
  return getSessionValues();
}

export async function putSecret(
  secretId: string,
  value: string,
  settings: Settings,
): Promise<{ ok: boolean; error?: string }> {
  if (settings.credentialStorage === 'vault') {
    const key = await activeKey();
    if (!key) return { ok: false, error: 'locked' };
    const vault = await getVault();
    if (!vault) return { ok: false, error: 'no-vault' };
    /* Ciphertext written on this call, not deferred to some later event --
       a credential that exists only in memory until a flush is a credential
       that vanishes when the worker is suspended. */
    await local.set(LOCAL_KEYS.vault, putRecord(vault, secretId, await encryptSecret(key, value)));
    await noteActivity(settings);
    return { ok: true };
  }

  const values = await getSessionValues();
  values[secretId] = value;
  const stored = await setSessionValues(values);
  return stored ? { ok: true } : { ok: false, error: 'no-session-storage' };
}

export async function deleteSecret(secretId: string): Promise<void> {
  const values = await getSessionValues();
  if (secretId in values) {
    delete values[secretId];
    await setSessionValues(values);
  }
  const vault = await getVault();
  if (vault?.records && secretId in vault.records) {
    await local.set(LOCAL_KEYS.vault, removeRecord(vault, secretId));
  }
}

/* Reveals one credential. Requires a passphrase and does real cryptographic
   work with it -- the key is re-derived from the vault salt and used to
   authenticate that specific record. It never reads the session cache, so
   removing the UI prompt does not produce a value. */
export async function revealSecret(
  secretId: string,
  passphrase: string,
  settings: Settings,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (settings.credentialStorage !== 'vault') {
    /* In session mode there is no passphrase and no ciphertext, so there is
       nothing to authenticate against. Saying so is more honest than
       pretending to check something. */
    return { ok: false, error: 'not-encrypted' };
  }
  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };
  try {
    return await decryptOne(vault, passphrase, secretId);
  } catch {
    return { ok: false, error: 'damaged-vault' };
  }
}

/* Removes stored values for secrets no profile references any more. Shared
   secrets survive because the caller passes every id still in use. */
export async function pruneOrphans(referencedIds: readonly string[]): Promise<string[]> {
  const keep = new Set(referencedIds);
  const removed: string[] = [];

  const values = await getSessionValues();
  let dirty = false;
  for (const id of Object.keys(values)) {
    if (!keep.has(id)) {
      delete values[id];
      dirty = true;
      removed.push(id);
    }
  }
  if (dirty) await setSessionValues(values);

  const vault = await getVault();
  if (vault?.records) {
    let next = vault;
    let vaultDirty = false;
    for (const id of Object.keys(vault.records)) {
      if (!keep.has(id)) {
        next = removeRecord(next, id);
        vaultDirty = true;
        removed.push(id);
      }
    }
    if (vaultDirty) await local.set(LOCAL_KEYS.vault, next);
  }

  return [...new Set(removed)];
}

/* Moving between modes must never leave a credential behind in the weaker
   store, nor silently promote a session value into a vault the user has not
   unlocked. */
export async function switchMode(
  next: CredentialMode,
  settings: Settings,
): Promise<{ ok: boolean; error?: string; carried: number }> {
  const current = await resolveSecrets(settings);

  if (next === 'vault') {
    const key = await activeKey();
    if (!key) return { ok: false, error: 'locked', carried: 0 };
    const vault = await getVault();
    if (!vault) return { ok: false, error: 'no-vault', carried: 0 };

    let updated = vault;
    for (const [id, value] of Object.entries(current)) {
      updated = putRecord(updated, id, await encryptSecret(key, value));
    }
    await local.set(LOCAL_KEYS.vault, updated);
    /* The session copies are dropped: leaving them would mean the values sit
       in two places and a lock would only clear one. */
    await session.remove(SESSION_KEYS.values);
    return { ok: true, carried: Object.keys(current).length };
  }

  await setSessionValues({ ...current });
  return { ok: true, carried: Object.keys(current).length };
}

export async function rotatePassphrase(
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<{ ok: boolean; error?: string; corrupt?: string[] }> {
  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  const result = await changePassphrase(vault, currentPassphrase, nextPassphrase);
  if (!result.ok) return { ok: false, error: result.error };

  await local.set(LOCAL_KEYS.vault, result.vault);
  const stored = await session.set(SESSION_KEYS.key, await exportKey(result.key));
  if (!stored) return { ok: false, error: 'no-session-storage' };
  return { ok: true, corrupt: result.corrupt };
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/* Records deliberate credential activity and pushes the lock deadline out.
 *
 * Network traffic is deliberately not activity: requests must not hold the
 * vault open, or a background poller would keep it unlocked indefinitely and
 * the timeout would measure nothing.
 *
 * An MV3 worker can be suspended at any moment, so the deadline is a timestamp
 * in storage.session and the alarm only wakes the worker to compare it against
 * the clock. */
export async function noteActivity(settings: Settings, now: number = Date.now()): Promise<void> {
  if (settings.credentialStorage !== 'vault') return;

  if (settings.disableAutoLock) {
    await session.remove(SESSION_KEYS.lockAt);
    await alarms.clear(LOCK_ALARM);
    return;
  }
  if (!(await isUnlocked())) return;

  const lockAt = now + settings.lockAfterMinutes * 60_000;
  await session.set(SESSION_KEYS.lockAt, lockAt);
  await alarms.clear(LOCK_ALARM);
  alarms.create(LOCK_ALARM, lockAt);
}

/* Alarms can fire late, so the stored deadline is re-checked before locking
   and rescheduled if activity extended it after the alarm was set. */
export async function handleLockAlarm(
  settings: Settings,
  now: number = Date.now(),
): Promise<{ locked: boolean; reason?: string }> {
  if (!(await isUnlocked())) return { locked: false, reason: 'already-locked' };
  if (settings.disableAutoLock) return { locked: false, reason: 'auto-lock-disabled' };

  const lockAt = await session.get<number>(SESSION_KEYS.lockAt);
  if (typeof lockAt !== 'number') return { locked: false, reason: 'no-deadline' };

  if (now < lockAt) {
    alarms.create(LOCK_ALARM, lockAt);
    return { locked: false, reason: 'not-yet-due' };
  }

  await lock();
  return { locked: true };
}

// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detail(err: unknown): { detail?: string } {
  const message = err instanceof Error ? err.message : String(err);
  return message ? { detail: message } : {};
}

export { validateVault };
