/* Host access, as a thing you can see and change.
 *
 * The per-profile control asks for exactly what a profile needs, which is the
 * right default and a poor fit for two real situations: wanting broad access
 * deliberately rather than as a side effect of how a profile happens to be
 * scoped, and wanting to take access back.
 *
 * Revocation matters more than it looks. Without it here, granting is one-way
 * from inside the extension and the only way out is Chrome's own settings --
 * which is a strange thing for an extension whose pitch is that it holds as
 * little as possible. Anything you can grant here you can withdraw here.
 */

import { useCallback, useEffect, useState } from 'react';
import { ALL_URLS, describeOrigin } from '../../core/origins';
import { hostPermissions } from '../../platform/permissions';
import { Button, Callout } from './primitives';

export function HostAccessPanel() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setOrigins(await hostPermissions.granted());
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const granted = await hostPermissions.granted();
      if (alive) setOrigins(granted);
    })();
    hostPermissions.onChanged(() => {
      if (alive) void refresh();
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const run = async (op: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await op();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (origins === null) return null;

  const hasAll = origins.includes(ALL_URLS) || origins.includes('<all_urls>');
  const specific = origins.filter((o) => o !== ALL_URLS && o !== '<all_urls>');

  return (
    <section className="hs-panel">
      <h2>Site access</h2>

      {hasAll ? (
        <Callout tone="warn" title="Headsmith can act on every site">
          <p>
            Rules apply wherever their scope matches, with no further prompting. This is more
            access than most setups need — profiles scoped to domains work with only those
            domains allowed.
          </p>
          <p className="hs-hint">
            It still cannot read anything. declarativeNetRequest hands the extension no request,
            response, header value or URL; broad access widens where rules apply, not what is
            visible.
          </p>
        </Callout>
      ) : specific.length > 0 ? (
        <>
          <p>Headsmith can act on these sites, and nowhere else:</p>
          <ul className="hs-origin-list">
            {specific.map((origin) => (
              <li key={origin}>
                <code>{describeOrigin(origin)}</code>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => hostPermissions.revoke([origin]))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hs-empty">
          No site access granted. Rules are compiled and handed to Chrome, which declines to act
          on them until a site is allowed.
        </p>
      )}

      <div className="hs-row">
        {!hasAll ? (
          /* The break-glass. Named for what it does rather than dressed up:
             someone reaching for it has usually decided that granting domain
             by domain is not worth it today, and hiding it only means they
             grant it from the Scope tab by writing a URL filter instead. */
          <Button
            disabled={busy}
            onClick={() => void run(() => hostPermissions.request([ALL_URLS]))}
            title="Grant access to every site"
          >
            Allow all sites
          </Button>
        ) : null}

        {origins.length > 0 ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void run(() => hostPermissions.revoke(origins))}
          >
            Revoke all site access
          </Button>
        ) : null}
      </div>

      <p className="hs-hint">
        Chrome asks before granting and never before revoking. The same list lives in Chrome&apos;s
        own extension settings, and changes made there appear here.
      </p>
    </section>
  );
}
