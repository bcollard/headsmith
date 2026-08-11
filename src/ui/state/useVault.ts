/* Vault state and the operations that change it.
 *
 * Lock and unlock go through the service worker rather than being performed
 * here, because both have to be followed by a rule rebuild -- and locking in
 * particular must drop the session rules, not merely forget the key. Doing it
 * in the popup would leave the browser still holding rules built from a
 * credential the user just locked away.
 *
 * Everything else (storing, deleting, revealing a secret) touches only the
 * secret store and is done directly.
 */

import { useCallback, useEffect, useState } from 'react';
import { runtime } from '../../platform/chrome';
import {
  initVault,
  putSecret,
  deleteSecret,
  revealSecret,
  rotatePassphrase,
  switchMode,
} from '../../background/secrets';
import type { CredentialMode, Settings } from '../../core/schema';

export interface VaultState {
  unlocked: boolean;
  exists: boolean;
  /** False when storage.session is unavailable; credentials cannot be held. */
  sessionStorage: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (passphrase: string) => Promise<boolean>;
  unlock: (passphrase: string) => Promise<boolean>;
  lock: () => Promise<void>;
  changePassphrase: (current: string, next: string) => Promise<boolean>;
  setMode: (mode: CredentialMode, settings: Settings) => Promise<boolean>;
  saveSecret: (secretId: string, value: string, settings: Settings) => Promise<boolean>;
  removeSecret: (secretId: string) => Promise<void>;
  reveal: (secretId: string, passphrase: string, settings: Settings) => Promise<string | null>;
}

interface StatusReply {
  ok: boolean;
  unlocked: boolean;
  vaultExists: boolean;
  sessionStorage: boolean;
}

export function useVault(): VaultState {
  const [unlocked, setUnlocked] = useState(false);
  const [exists, setExists] = useState(false);
  const [sessionStorage, setSessionStorage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const reply = (await runtime.send({ type: 'status' })) as StatusReply;
      setUnlocked(reply.unlocked);
      setExists(reply.vaultExists);
      setSessionStorage(reply.sessionStorage);
    } catch {
      /* The worker may be starting up. The next event refreshes this. */
    }
  }, []);

  useEffect(() => {
    /* Asking the worker for its state is a subscription to an external system,
       so the query lives in the effect rather than being called from it. The
       `alive` guard matters in a popup: it can be dismissed mid-request, and
       an unguarded reply would set state on an unmounted component. */
    let alive = true;
    void (async () => {
      try {
        const reply = (await runtime.send({ type: 'status' })) as StatusReply;
        if (!alive) return;
        setUnlocked(reply.unlocked);
        setExists(reply.vaultExists);
        setSessionStorage(reply.sessionStorage);
      } catch {
        /* The worker may still be starting. A later action refreshes this. */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* Wraps an operation so a slow PBKDF2 derivation cannot be triggered twice
     by an impatient second click, and so failures surface as text rather than
     an unhandled rejection in a popup nobody has devtools open on. */
  const run = useCallback(
    async <T,>(operation: () => Promise<T>, fallback: T): Promise<T> => {
      setBusy(true);
      setError(null);
      try {
        return await operation();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return fallback;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const create = useCallback(
    (passphrase: string) =>
      run(async () => {
        const result = await initVault(passphrase);
        if (!result.ok) {
          setError(describe(result.error));
          return false;
        }
        await refresh();
        return true;
      }, false),
    [run, refresh],
  );

  const unlock = useCallback(
    (passphrase: string) =>
      run(async () => {
        const reply = (await runtime.send({ type: 'unlock', passphrase })) as {
          ok: boolean;
          error?: string;
        };
        if (!reply.ok) {
          setError(describe(reply.error));
          return false;
        }
        await refresh();
        return true;
      }, false),
    [run, refresh],
  );

  const lock = useCallback(
    () =>
      run(async () => {
        await runtime.send({ type: 'lock' });
        await refresh();
      }, undefined),
    [run, refresh],
  );

  const changePassphrase = useCallback(
    (current: string, next: string) =>
      run(async () => {
        const result = await rotatePassphrase(current, next);
        if (!result.ok) {
          setError(describe(result.error));
          return false;
        }
        return true;
      }, false),
    [run],
  );

  const setMode = useCallback(
    (mode: CredentialMode, settings: Settings) =>
      run(async () => {
        const result = await switchMode(mode, settings);
        if (!result.ok) {
          setError(describe(result.error));
          return false;
        }
        return true;
      }, false),
    [run],
  );

  const saveSecret = useCallback(
    (secretId: string, value: string, settings: Settings) =>
      run(async () => {
        const result = await putSecret(secretId, value, settings);
        if (!result.ok) setError(describe(result.error));
        return result.ok;
      }, false),
    [run],
  );

  const removeSecret = useCallback(
    (secretId: string) => run(() => deleteSecret(secretId), undefined),
    [run],
  );

  const reveal = useCallback(
    (secretId: string, passphrase: string, settings: Settings) =>
      run(async () => {
        const result = await revealSecret(secretId, passphrase, settings);
        if (!result.ok) {
          setError(describe(result.error));
          return null;
        }
        return result.value;
      }, null),
    [run],
  );

  return {
    unlocked,
    exists,
    sessionStorage,
    busy,
    error,
    refresh,
    create,
    unlock,
    lock,
    changePassphrase,
    setMode,
    saveSecret,
    removeSecret,
    reveal,
  };
}

/* Error codes are deliberately terse in the secret store so nothing about a
   value leaks into a message. Turning them into sentences is a UI concern. */
function describe(code: string | undefined): string {
  switch (code) {
    case 'incorrect-passphrase':
      return 'That passphrase is not correct.';
    case 'decrypt-failed':
      return 'Could not decrypt. The passphrase is wrong, or the record is damaged.';
    case 'no-vault':
      return 'There is no vault yet. Create one first.';
    case 'locked':
      return 'The vault is locked. Unlock it first.';
    case 'damaged-vault':
      return 'The vault could not be read. You may need to reset it.';
    case 'no-such-secret':
      return 'That credential is no longer stored.';
    case 'not-encrypted':
      return 'Credentials are not encrypted in session-only mode, so there is nothing to reveal.';
    case 'no-session-storage':
      return 'Session storage is unavailable, so credentials cannot be held. Restart the browser.';
    default:
      return code ? `Something went wrong (${code}).` : 'Something went wrong.';
  }
}
