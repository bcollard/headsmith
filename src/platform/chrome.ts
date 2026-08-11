/* Thin wrappers over the chrome.* APIs Headsmith uses.
 *
 * This layer exists so that src/core can stay pure. Everything here is a
 * near-transparent forward to a browser API -- no decisions, no branching on
 * user data. If a function in this file grows a policy question, that question
 * belongs in src/core instead.
 *
 * `chrome.*` is accessed through a getter rather than captured at module load,
 * so tests can install a fake before the first call. There is deliberately no
 * webextension-polyfill: Chrome's own APIs return promises for everything used
 * here, and a polyfill would be a dependency earning nothing.
 */

type ChromeLike = typeof chrome;

function api(): ChromeLike {
  const c = (globalThis as { chrome?: ChromeLike }).chrome;
  if (!c) throw new Error('chrome APIs are unavailable in this context');
  return c;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/* storage.local: profiles, settings, vault ciphertext. Survives restarts. */
export const local = {
  async get<T>(key: string): Promise<T | undefined> {
    const bag = await api().storage.local.get(key);
    return bag[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await api().storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await api().storage.local.remove(key);
  },
};

/* storage.session: the derived vault key and session-mode credential values.
 *
 * Chrome clears this when the browser process exits, which is the mechanism
 * behind "credentials never touch disk". Its default access level is
 * TRUSTED_CONTEXTS, keeping it out of content scripts -- setAccessLevel is
 * never called, and the egress guard fails the build if that call appears in
 * the bundle.
 *
 * Reads fail closed: if the area is unavailable for any reason we return
 * nothing rather than falling back to storage.local, because the fallback
 * would write a credential to disk to avoid an inconvenience. */
export const session = {
  available(): boolean {
    return Boolean((globalThis as { chrome?: ChromeLike }).chrome?.storage?.session);
  },
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.available()) return undefined;
    try {
      const bag = await api().storage.session.get(key);
      return bag[key] as T | undefined;
    } catch {
      return undefined;
    }
  },
  /* Returns false when the value could not be stored, so callers can refuse to
     proceed rather than assume a credential was cached. */
  async set(key: string, value: unknown): Promise<boolean> {
    if (!this.available()) return false;
    try {
      await api().storage.session.set({ [key]: value });
      return true;
    } catch {
      return false;
    }
  },
  async remove(keys: string | string[]): Promise<void> {
    if (!this.available()) return;
    try {
      await api().storage.session.remove(keys);
    } catch {
      /* The values are memory-only regardless, so a failure here cannot leave
         a credential somewhere durable. */
    }
  },
};

export function onStorageChanged(
  handler: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
): void {
  api().storage.onChanged.addListener(handler);
}

// ---------------------------------------------------------------------------
// declarativeNetRequest
// ---------------------------------------------------------------------------

export interface RuleUpdate {
  removeRuleIds?: number[];
  addRules?: chrome.declarativeNetRequest.Rule[];
}

export const dnr = {
  getDynamic(): Promise<chrome.declarativeNetRequest.Rule[]> {
    return api().declarativeNetRequest.getDynamicRules();
  },
  updateDynamic(update: RuleUpdate): Promise<void> {
    return api().declarativeNetRequest.updateDynamicRules(update);
  },
  getSession(): Promise<chrome.declarativeNetRequest.Rule[]> {
    return api().declarativeNetRequest.getSessionRules();
  },
  updateSession(update: RuleUpdate): Promise<void> {
    return api().declarativeNetRequest.updateSessionRules(update);
  },
};

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export const alarms = {
  create(name: string, when: number): void {
    try {
      api().alarms.create(name, { when });
    } catch {
      /* Without alarms the vault still locks on browser restart, because the
         key lives in storage.session. Only the idle timeout is lost. */
    }
  },
  async clear(name: string): Promise<void> {
    try {
      await api().alarms.clear(name);
    } catch {
      /* An orphaned alarm is harmless: it re-checks the deadline and exits. */
    }
  },
  onAlarm(handler: (alarm: chrome.alarms.Alarm) => void): void {
    api().alarms.onAlarm.addListener(handler);
  },
};

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export const badge = {
  async set(text: string, color: string, title: string): Promise<void> {
    const action = api().action;
    await action.setBadgeText({ text });
    await action.setBadgeBackgroundColor({ color });
    await action.setTitle({ title });
    try {
      await action.setBadgeTextColor({ color: '#FFFFFF' });
    } catch {
      /* setBadgeTextColor needs Chrome 110; the badge works without it. */
    }
  },
};

// ---------------------------------------------------------------------------
// Messaging and lifecycle
// ---------------------------------------------------------------------------

export const runtime = {
  onMessage(
    handler: (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (response: unknown) => void,
    ) => boolean | void,
  ): void {
    api().runtime.onMessage.addListener(handler);
  },
  onInstalled(handler: () => void): void {
    api().runtime.onInstalled.addListener(handler);
  },
  onStartup(handler: () => void): void {
    api().runtime.onStartup.addListener(handler);
  },
  send(message: unknown): Promise<unknown> {
    return api().runtime.sendMessage(message);
  },
};

export const commands = {
  onCommand(handler: (command: string) => void): void {
    api().commands?.onCommand.addListener(handler);
  },
};
