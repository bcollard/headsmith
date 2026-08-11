/* Credential storage.
 *
 * The mode split and the activity-based auto-lock are ideas from OpenModHeader
 * (MIT, (c) 2026 Shiva M). This implementation is not; see NOTICE.md.
 *
 * Two modes, and deliberately not three:
 *
 *   session   values live in storage.session, which Chrome clears when the
 *             browser exits. Nothing touches disk. The cost is retyping after
 *             a restart. This is the default.
 *   vault     values are encrypted into storage.local under a passphrase-
 *             derived key that lives in storage.session and is dropped on lock.
 *
 * There is no persistent-plaintext mode. It would be the only path by which a
 * credential reaches disk unencrypted, and keeping it would mean carving an
 * exception into the plaintext-secret test -- and an exception in that test is
 * the test.
 *
 * ## Shape
 *
 * The two modes are two implementations of one `SecretStore` interface, chosen
 * once by `storeFor`. The alternative is a module of functions that each begin
 * by branching on the mode, which puts the same three-line conditional in
 * eight places and makes "does this path handle vault mode correctly?" a
 * question you answer eight times.
 *
 * Operations that are meaningless in a mode say so rather than pretending:
 * there is no passphrase in session mode, so there is nothing for `reveal` to
 * verify, and it returns `not-encrypted` instead of handing the value back.
 */

import {
  createVault,
  exportKey,
  forgetSecret,
  importKey,
  readAll,
  readSecretWithPassphrase,
  rekeyVault,
  unlockVault,
  writeSecret,
  type VaultFile,
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

export type Failure =
  | 'locked'
  | 'no-vault'
  | 'no-session-storage'
  | 'not-encrypted'
  | 'incorrect-passphrase'
  | 'damaged-vault'
  | 'no-such-secret'
  | 'decrypt-failed';

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: Failure };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: Failure): Result<never> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// The two stores
// ---------------------------------------------------------------------------

interface SecretStore {
  readAll(): Promise<Record<string, string>>;
  write(secretId: string, value: string): Promise<Result>;
  forget(secretId: string): Promise<void>;
  /** Prunes ids no profile references. Returns what it removed. */
  prune(keep: ReadonlySet<string>): Promise<string[]>;
  /** Only the vault can verify a passphrase, so only it can reveal. */
  reveal(secretId: string, passphrase: string): Promise<Result<string>>;
}

/* Session mode. Values are held in a single storage.session key; Chrome
   discards the whole area when the browser process ends, which is the entire
   guarantee this mode offers and the reason it needs no crypto. */
const sessionStore: SecretStore = {
  async readAll() {
    const held = await session.get<Record<string, string>>(SESSION_KEYS.values);
    return held && typeof held === 'object' ? held : {};
  },

  async write(secretId, value) {
    const values = await this.readAll();
    /* Fail loudly if the write did not land. A caller that assumes success
       shows the user a configured profile that quietly sends nothing. */
    return (await session.set(SESSION_KEYS.values, { ...values, [secretId]: value }))
      ? ok(undefined)
      : fail('no-session-storage');
  },

  async forget(secretId) {
    const values = await this.readAll();
    if (!(secretId in values)) return;
    delete values[secretId];
    await session.set(SESSION_KEYS.values, values);
  },

  async prune(keep) {
    const values = await this.readAll();
    const removed = Object.keys(values).filter((id) => !keep.has(id));
    if (removed.length === 0) return [];
    for (const id of removed) delete values[id];
    await session.set(SESSION_KEYS.values, values);
    return removed;
  },

  async reveal() {
    /* No ciphertext and no passphrase, so there is nothing to authenticate
       against. Saying so is more honest than a prompt that checks nothing. */
    return fail('not-encrypted');
  },
};

/* Vault mode. Ciphertext in storage.local, key in storage.session. */
const vaultStore: SecretStore = {
  async readAll() {
    /* Decrypted on demand with the cached key. PBKDF2 is not re-run here --
       only the AES-GCM step, cheap enough to do on every rule build. */
    const key = await cachedKey();
    const vault = await getVault();
    if (!key || !vault) return {};
    return (await readAll(vault, key)).values;
  },

  async write(secretId, value) {
    const key = await cachedKey();
    if (!key) return fail('locked');
    const vault = await getVault();
    if (!vault) return fail('no-vault');
    /* Written now, not deferred: a credential that exists only in memory until
       some later flush is a credential lost when the worker is suspended. */
    await putVault(await writeSecret(vault, key, secretId, value));
    return ok(undefined);
  },

  async forget(secretId) {
    const vault = await getVault();
    if (!vault) return;
    const next = forgetSecret(vault, secretId);
    if (next !== vault) await putVault(next);
  },

  async prune(keep) {
    const vault = await getVault();
    if (!vault) return [];
    const removed = Object.keys(vault.records).filter((id) => !keep.has(id));
    if (removed.length === 0) return [];
    await putVault(removed.reduce(forgetSecret, vault));
    return removed;
  },

  async reveal(secretId, passphrase) {
    const vault = await getVault();
    if (!vault) return fail('no-vault');
    try {
      const result = await readSecretWithPassphrase(vault, passphrase, secretId);
      return result.ok ? ok(result.value) : fail(result.error);
    } catch {
      return fail('damaged-vault');
    }
  },
};

function storeFor(settings: Settings): SecretStore {
  return settings.credentialStorage === 'vault' ? vaultStore : sessionStore;
}

// ---------------------------------------------------------------------------
// Vault file and key
// ---------------------------------------------------------------------------

export async function getVault(): Promise<VaultFile | null> {
  return (await local.get<VaultFile>(LOCAL_KEYS.vault)) ?? null;
}

async function putVault(vault: VaultFile): Promise<void> {
  await local.set(LOCAL_KEYS.vault, vault);
}

export async function vaultExists(): Promise<boolean> {
  return (await getVault()) !== null;
}

export async function isUnlocked(): Promise<boolean> {
  return Boolean(await session.get<string>(SESSION_KEYS.key));
}

async function cachedKey(): Promise<CryptoKey | null> {
  const raw = await session.get<string>(SESSION_KEYS.key);
  if (!raw) return null;
  try {
    return await importKey(raw);
  } catch {
    return null;
  }
}

export async function initVault(passphrase: string): Promise<{ ok: boolean; error?: Failure }> {
  const { vault, key } = await createVault(passphrase);
  await putVault(vault);
  if (!(await session.set(SESSION_KEYS.key, await exportKey(key)))) {
    return { ok: false, error: 'no-session-storage' };
  }
  /* Credentials already held in session mode are left alone. Creating a vault
     is not the same act as switching to it -- switchMode moves them across,
     and it can only do that if they are still here. */
  return { ok: true };
}

/* Unlock throttling. PBKDF2 at 600,000 iterations already costs about half a
   second, which is the real defence; this makes the cost explicit so the rate
   is not simply whatever the machine can manage. The counter lives in session
   storage and resets on browser restart, which is acceptable: a restart is no
   cheaper for an attacker than waiting. */
const FREE_ATTEMPTS = 5;
const BACKOFF_STEP_MS = 2000;

export type UnlockResult =
  | { ok: true; unreadable: string[] }
  | { ok: false; error: Failure; detail?: string };

export async function unlock(passphrase: string, settings: Settings): Promise<UnlockResult> {
  const failures = (await session.get<number>(SESSION_KEYS.failures)) ?? 0;
  if (failures >= FREE_ATTEMPTS) {
    /* Linear rather than exponential: this is a speed bump against scripted
       guessing, and an exponential curve eventually locks out someone who
       merely mistyped a long passphrase a few times. */
    await pause((failures - FREE_ATTEMPTS + 1) * BACKOFF_STEP_MS);
  }

  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  let key: CryptoKey | null;
  try {
    key = await unlockVault(vault, passphrase);
  } catch (err) {
    return {
      ok: false,
      error: 'damaged-vault',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!key) {
    await session.set(SESSION_KEYS.failures, failures + 1);
    return { ok: false, error: 'incorrect-passphrase' };
  }

  /* Only the derived key is cached. Plaintext credentials are never mirrored
     into session storage in vault mode, so an unlocked vault does not leave a
     readable dump of every credential sitting in a storage area. */
  if (!(await session.set(SESSION_KEYS.key, await exportKey(key)))) {
    return { ok: false, error: 'no-session-storage' };
  }

  await session.remove(SESSION_KEYS.failures);
  const { unreadable } = await readAll(vault, key);
  await noteActivity(settings);
  return { ok: true, unreadable };
}

/* Clears every trace of the unlocked state. Ciphertext and configuration are
   untouched, so unlocking restores everything. */
export async function lock(): Promise<void> {
  await session.remove([SESSION_KEYS.values, SESSION_KEYS.key, SESSION_KEYS.lockAt]);
  await alarms.clear(LOCK_ALARM);
}

export async function resetVault(): Promise<void> {
  await lock();
  await local.remove(LOCAL_KEYS.vault);
}

export async function rotatePassphrase(
  current: string,
  next: string,
): Promise<{ ok: boolean; error?: Failure; unreadable?: string[] }> {
  const vault = await getVault();
  if (!vault) return { ok: false, error: 'no-vault' };

  const result = await rekeyVault(vault, current, next);
  if (!result.ok) return { ok: false, error: result.error as Failure };

  await putVault(result.vault);
  if (!(await session.set(SESSION_KEYS.key, await exportKey(result.key)))) {
    return { ok: false, error: 'no-session-storage' };
  }
  return { ok: true, unreadable: result.unreadable };
}

// ---------------------------------------------------------------------------
// The operations the rest of the extension calls
// ---------------------------------------------------------------------------

/* The one place credentials are resolved for rule building. Returns a plain
   map so the compiler can be handed a synchronous resolver. */
export async function resolveSecrets(settings: Settings): Promise<Record<string, string>> {
  return storeFor(settings).readAll();
}

export async function putSecret(
  secretId: string,
  value: string,
  settings: Settings,
): Promise<{ ok: boolean; error?: Failure }> {
  const result = await storeFor(settings).write(secretId, value);
  if (!result.ok) return { ok: false, error: result.error };
  await noteActivity(settings);
  return { ok: true };
}

/* Removes a value from both stores regardless of the active mode. A secret can
   be left behind in the other store by a mode switch, and "delete this
   credential" has to mean it is gone, not gone from wherever we happen to be
   looking. */
export async function deleteSecret(secretId: string): Promise<void> {
  await sessionStore.forget(secretId);
  await vaultStore.forget(secretId);
}

export async function revealSecret(
  secretId: string,
  passphrase: string,
  settings: Settings,
): Promise<{ ok: true; value: string } | { ok: false; error: Failure }> {
  const result = await storeFor(settings).reveal(secretId, passphrase);
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}

/* Removes stored values nothing references any more, from both stores for the
   same reason as deleteSecret. Shared secrets survive because the caller
   passes every id still in use. */
export async function pruneOrphans(referencedIds: readonly string[]): Promise<string[]> {
  const keep = new Set(referencedIds);
  const removed = [...(await sessionStore.prune(keep)), ...(await vaultStore.prune(keep))];
  return [...new Set(removed)];
}

/* Moves values between modes. Must never leave a credential behind in the
   weaker store, nor promote one into a vault the user has not unlocked. */
export async function switchMode(
  next: CredentialMode,
  settings: Settings,
): Promise<{ ok: boolean; error?: Failure; carried: number }> {
  const current = await storeFor(settings).readAll();
  const entries = Object.entries(current);

  if (next === 'vault') {
    const key = await cachedKey();
    if (!key) return { ok: false, error: 'locked', carried: 0 };
    let vault = await getVault();
    if (!vault) return { ok: false, error: 'no-vault', carried: 0 };

    for (const [secretId, value] of entries) {
      vault = await writeSecret(vault, key, secretId, value);
    }
    await putVault(vault);
    /* The session copies go. Leaving them would put each value in two places,
       and a lock would clear only one of them. */
    await session.remove(SESSION_KEYS.values);
    return { ok: true, carried: entries.length };
  }

  const result = await session.set(SESSION_KEYS.values, { ...current });
  return result
    ? { ok: true, carried: entries.length }
    : { ok: false, error: 'no-session-storage', carried: 0 };
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/* Records deliberate credential activity and pushes the deadline out.
 *
 * Network traffic is deliberately not activity. If requests counted, a
 * background poller would hold the vault open indefinitely and the timeout
 * would measure nothing at all.
 *
 * An MV3 worker can be suspended at any moment, so the deadline is a timestamp
 * in session storage and the alarm exists only to wake the worker up to
 * compare it against the clock. */
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

/* Alarms can fire late, and activity after one was scheduled extends the
   deadline. Locking on the alarm alone would therefore close the vault early,
   so the stored deadline is re-checked and the alarm rescheduled if it is not
   yet due. */
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
