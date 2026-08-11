/* Diagnostics from the service worker.
 *
 * The worker writes a status object to storage.local after every rule build:
 * which rules the engine refused, which profiles had their credential half
 * withheld and why, and how much of the rule budget is in use. The UI only
 * ever reads it -- writing here would trigger the worker's storage listener
 * and cause a rebuild loop.
 */

import { useEffect, useState } from 'react';
import { loadStatus, STATUS_KEY, type Status } from '../../background/store';
import { onStorageChanged } from '../../platform/chrome';

export function useStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    void loadStatus().then((s) => {
      if (alive && s) setStatus(s);
    });

    onStorageChanged((changes, area) => {
      if (area !== 'local' || !(STATUS_KEY in changes)) return;
      const next = changes[STATUS_KEY]?.newValue as Status | undefined;
      if (next) setStatus(next);
    });

    return () => {
      alive = false;
    };
  }, []);

  return status;
}
