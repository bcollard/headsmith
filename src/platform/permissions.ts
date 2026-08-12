/* Host permissions, requested at runtime.
 *
 * A thin wrapper, like the rest of src/platform. The one thing worth knowing
 * about the API it wraps: `request` must be called from a user gesture, so it
 * has to be reached from a click and cannot be triggered by typing or by the
 * worker. That constraint shapes the UI, not this file.
 */

type ChromeLike = typeof chrome;

function api(): ChromeLike {
  const c = (globalThis as { chrome?: ChromeLike }).chrome;
  if (!c) throw new Error('chrome APIs are unavailable in this context');
  return c;
}

export const hostPermissions = {
  /** Every origin pattern currently granted. */
  async granted(): Promise<string[]> {
    try {
      const all = await api().permissions.getAll();
      return all.origins ?? [];
    } catch {
      return [];
    }
  },

  /** Chrome's own answer, which is the authoritative one. */
  async has(origins: readonly string[]): Promise<boolean> {
    if (origins.length === 0) return true;
    try {
      return await api().permissions.contains({ origins: [...origins] });
    } catch {
      return false;
    }
  },

  /* Must be called from a user gesture. Resolves false when the user declines,
     which is an ordinary outcome rather than an error. */
  async request(origins: readonly string[]): Promise<boolean> {
    if (origins.length === 0) return true;
    try {
      return await api().permissions.request({ origins: [...origins] });
    } catch {
      return false;
    }
  },

  async revoke(origins: readonly string[]): Promise<boolean> {
    if (origins.length === 0) return true;
    try {
      return await api().permissions.remove({ origins: [...origins] });
    } catch {
      return false;
    }
  },

  /* Fires when a permission is granted or removed, including from Chrome's own
     settings pages -- which is the case that matters. A user revoking access
     out there would otherwise leave rules that quietly stop applying with
     nothing on screen to explain it. */
  onChanged(handler: () => void): void {
    try {
      api().permissions.onAdded.addListener(handler);
      api().permissions.onRemoved.addListener(handler);
    } catch {
      /* Nothing to observe; the UI still re-checks whenever it opens. */
    }
  },
};
