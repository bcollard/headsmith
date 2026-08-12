/* Whether this profile is allowed to touch the hosts it names.
 *
 * `chrome.permissions.request` only works from a user gesture, so granting has
 * to be a button. That is not a limitation to work around -- it is the whole
 * point of the design, since it means a host is only ever added because
 * somebody clicked to add it.
 */

import { useCallback, useEffect, useState } from 'react';
import { hostPermissions } from '../../platform/permissions';
import { isCovered, type OriginNeed } from '../../core/origins';

export interface HostPermissionState {
  /** Null until the first check resolves, so the UI can avoid flickering. */
  granted: boolean | null;
  busy: boolean;
  /** Must be called from a click. False when the user declines. */
  request: () => Promise<boolean>;
  revoke: () => Promise<boolean>;
  refresh: () => void;
}

export function useHostPermissions(need: OriginNeed): HostPermissionState {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  /* Depend on the patterns themselves rather than the object, which is rebuilt
     on every render of the editor. */
  const key = need.origins.join('|');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const has = need.origins.length === 0 ? true : await hostPermissions.has(need.origins);
      if (alive) setGranted(has);
    })();

    /* A revocation can happen in Chrome's settings while this page is open. */
    hostPermissions.onChanged(() => {
      if (alive) setTick((n) => n + 1);
    });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const request = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await hostPermissions.request(need.origins);
      setGranted(ok || (await hostPermissions.has(need.origins)));
      return ok;
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await hostPermissions.revoke(need.origins);
      setGranted(await hostPermissions.has(need.origins));
      return ok;
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { granted, busy, request, revoke, refresh: () => setTick((n) => n + 1) };
}

export { isCovered };
