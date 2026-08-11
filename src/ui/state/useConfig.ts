/* Configuration state for the UI.
 *
 * The write path is the interesting part. Saving to storage.local is what
 * triggers the service worker to recompile and reapply every rule, so a naive
 * save-on-keystroke would rebuild the entire rule set for every character
 * typed into a header value. Writes are therefore debounced, while local state
 * updates immediately so typing stays responsive.
 *
 * The current config is held in a ref as well as in state. That is not
 * belt-and-braces: a React state updater must be a pure function of its
 * argument, so it cannot be where the next value is computed *and* captured
 * for saving. StrictMode invokes updaters twice precisely to surface that
 * mistake. The ref is the single place "what is the config right now?" is
 * answered, and the updater does nothing but return it.
 *
 * One consequence worth keeping in mind: for a few hundred milliseconds after
 * a keystroke, the screen is ahead of what the browser is enforcing. `pending`
 * exposes that so the status bar can avoid reporting a rule count that is
 * about to change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIG_KEY, loadConfig, saveConfig } from '../../background/store';
import { onStorageChanged } from '../../platform/chrome';
import type { Config } from '../../core/schema';

const SAVE_DEBOUNCE_MS = 300;

export interface ConfigState {
  config: Config | null;
  /** True while an edit has been made but not yet written to storage. */
  pending: boolean;
  /** Applies a change. Immediate on screen, debounced to storage. */
  update: (fn: (config: Config) => Config) => void;
  /** Applies a change and writes it immediately, for structural edits. */
  updateNow: (fn: (config: Config) => Config) => Promise<void>;
  /** Replaces the whole config, e.g. on import. */
  replace: (config: Config) => Promise<void>;
}

export function useConfig(): ConfigState {
  const [config, setConfig] = useState<Config | null>(null);
  const [pending, setPending] = useState(false);

  /* The authoritative current value. State drives rendering; this drives
     writes, and is updated synchronously so two edits in the same tick
     compose instead of the second overwriting the first. */
  const latest = useRef<Config | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* What this view last wrote, so the storage listener can tell its own echo
     from a change made in another window. Without it every save would bounce
     back and clobber the field being typed in. */
  const lastWritten = useRef<string>('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const loaded = await loadConfig();
      if (!alive) return;
      latest.current = loaded;
      setConfig(loaded);
    })();

    onStorageChanged((changes, area) => {
      if (area !== 'local' || !(CONFIG_KEY in changes)) return;
      const next = changes[CONFIG_KEY]?.newValue as Config | undefined;
      if (!next) return;
      if (JSON.stringify(next) === lastWritten.current) return; // our own write
      latest.current = next;
      setConfig(next);
    });

    return () => {
      alive = false;
    };
  }, []);

  const flush = useCallback(async () => {
    const next = latest.current;
    if (!next) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    lastWritten.current = JSON.stringify(next);
    await saveConfig(next);
    setPending(false);
  }, []);

  /* Applies `fn` to the current value and publishes it. The state updater is a
     plain identity on the already-computed result, so it stays pure. */
  const apply = useCallback((fn: (config: Config) => Config): Config | null => {
    const current = latest.current;
    if (!current) return null;
    const next = fn(current);
    latest.current = next;
    setConfig(next);
    return next;
  }, []);

  const update = useCallback(
    (fn: (config: Config) => Config) => {
      if (!apply(fn)) return;
      setPending(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [apply, flush],
  );

  const updateNow = useCallback(
    async (fn: (config: Config) => Config) => {
      if (!apply(fn)) return;
      await flush();
    },
    [apply, flush],
  );

  const replace = useCallback(
    async (next: Config) => {
      latest.current = next;
      setConfig(next);
      await flush();
    },
    [flush],
  );

  /* A pending write must not be lost because the popup closed -- which is the
     normal way a popup ends, not an edge case. */
  useEffect(() => {
    const save = () => {
      if (timer.current) void flush();
    };
    document.addEventListener('visibilitychange', save);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', save);
      window.removeEventListener('pagehide', save);
    };
  }, [flush]);

  return { config, pending, update, updateNow, replace };
}
