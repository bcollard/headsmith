/* The application shell.
 *
 * One bundle serves both surfaces. The action popup is narrow and short, so it
 * shows the active profile's headers and nothing else -- the things you reach
 * for while debugging. Scoping, credentials and settings live behind tabs that
 * only make sense with room, and the popup links out to the options page for
 * them rather than cramming them into 380 pixels.
 */

import { useMemo, useState } from 'react';
import { useConfig } from './state/useConfig';
import { useStatus } from './state/useStatus';
import { useVault } from './state/useVault';
import { HeaderTable } from './components/HeaderTable';
import { CompactMatchEditor, MatchEditor } from './components/MatchEditor';
import { ProfileBar, ProfileHeader, ProfileList } from './components/ProfileList';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { VaultPanel } from './components/VaultPanel';
import { Button, Callout, Toggle } from './components/primitives';
import { hasSensitiveContent } from '../core/sensitivity';
import type { Config, HeaderOp, Profile, Settings } from '../core/schema';

type Tab = 'headers' | 'scope' | 'credentials' | 'settings';

/* The popup is opened as the browser action; the options page is a full tab.
   Chrome does not label them, so the width is the only reliable signal. */
function isPopup(): boolean {
  return window.innerWidth < 600 && !window.location.search.includes('expanded');
}

export function App() {
  const { config, pending, update, updateNow, replace } = useConfig();
  const status = useStatus();
  const vault = useVault();
  const [tab, setTab] = useState<Tab>('headers');
  const popup = useMemo(() => isPopup(), []);

  const blockedIds = useMemo(
    () => new Set((status?.blocked ?? []).map((b) => b.profileId)),
    [status],
  );

  if (!config) {
    return (
      <div className="hs-loading" role="status">
        Loading…
      </div>
    );
  }

  const profile = config.profiles.find((p) => p.id === config.activeProfileId) ?? config.profiles[0]!;

  const setProfile = (patch: Partial<Profile>) =>
    update((c) => ({
      ...c,
      profiles: c.profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)),
    }));

  const setSettings = (patch: Partial<Settings>) =>
    void updateNow((c) => ({ ...c, settings: { ...c.settings, ...patch } }));

  const setSecretLabel = (secretId: string, label: string) =>
    update((c) => ({
      ...c,
      secretsMeta: {
        ...c.secretsMeta,
        [secretId]: { label, createdAt: c.secretsMeta[secretId]?.createdAt || Date.now() },
      },
    }));

  const headerProps = {
    settings: config.settings,
    vault,
    onSecretLabel: setSecretLabel,
  };

  return (
    <div className={`hs-app${popup ? ' hs-popup' : ''}`}>
      <header className="hs-topbar">
        {/* Local asset, same one the toolbar uses. Nothing here is fetched
            from off-origin -- see scripts/guard-egress.mjs. */}
        <img className="hs-logo" src="/icons/icon32.png" width="20" height="20" alt="" />
        <span className="hs-brand">Headsmith</span>
        <Toggle
          checked={!config.paused}
          onChange={(on) => void updateNow((c) => ({ ...c, paused: !on }))}
          label={config.paused ? 'Paused' : 'Active'}
        />
        {popup ? (
          <Button
            variant="ghost"
            onClick={() => void chrome.runtime.openOptionsPage()}
            title="Open the full editor"
          >
            Expand ↗
          </Button>
        ) : null}
      </header>

      <StatusBar status={status} pending={pending} paused={config.paused} />

      <div className="hs-body">
        {/* Creating, duplicating, deleting and recolouring profiles are
            decisions made once, not things reached for mid-debug, so they stay
            in the full editor. The popup gets one profile it can rename in
            place, and a switcher only once a second profile exists. */}
        {!popup ? (
          <ProfileList
            config={config}
            blockedIds={blockedIds}
            onSelect={(id) => void updateNow((c) => ({ ...c, activeProfileId: id }))}
            onChange={update}
          />
        ) : null}

        <main className="hs-main">
          {popup ? (
            <ProfileBar
              config={config}
              onSelect={(id) => void updateNow((c) => ({ ...c, activeProfileId: id }))}
              onRename={(name) => setProfile({ name })}
            />
          ) : (
            <ProfileHeader profile={profile} onChange={setProfile} />
          )}

          {!popup ? (
            <nav className="hs-tabs" role="tablist">
              {(['headers', 'scope', 'credentials', 'settings'] as Tab[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  className={tab === name ? 'hs-tab hs-tab-on' : 'hs-tab'}
                  onClick={() => setTab(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
          ) : null}

          {popup || tab === 'headers' ? (
            <>
              <h3>Request headers</h3>
              <HeaderTable
                {...headerProps}
                headers={profile.requestHeaders}
                target="request"
                onChange={(requestHeaders: HeaderOp[]) => setProfile({ requestHeaders })}
              />

              <h3>Response headers</h3>
              <HeaderTable
                {...headerProps}
                headers={profile.responseHeaders}
                target="response"
                onChange={(responseHeaders: HeaderOp[]) => setProfile({ responseHeaders })}
              />

              {popup ? (
                <>
                  <h3>Where it applies</h3>
                  <CompactMatchEditor
                    match={profile.match}
                    hasCredential={hasSensitiveContent(profile)}
                    onChange={(match) => setProfile({ match })}
                  />
                  <p className="hs-hint hs-popup-note">
                    Regexes, exclusions, request types, credentials and profile management are
                    in the full editor.
                  </p>
                </>
              ) : null}
            </>
          ) : null}

          {!popup && tab === 'scope' ? (
            <>
              <MatchEditor
                match={profile.match}
                hasCredential={hasSensitiveContent(profile)}
                onChange={(match) => setProfile({ match })}
              />
              {hasSensitiveContent(profile) ? (
                <Toggle
                  checked={profile.allowGlobalSensitive}
                  onChange={(on) => setProfile({ allowGlobalSensitive: on })}
                  label="Allow this profile's credential everywhere"
                  hint="Only this profile. Accepting the risk here does not turn the protection off for the others."
                />
              ) : null}
            </>
          ) : null}

          {!popup && tab === 'credentials' ? (
            <VaultPanel config={config} vault={vault} onSettings={setSettings} />
          ) : null}

          {!popup && tab === 'settings' ? (
            <SettingsPanel
              config={config}
              onChange={update}
              onReplace={(next: Config) => replace(next)}
            />
          ) : null}
        </main>
      </div>

      {config.settings.credentialStorage === 'vault' && !vault.unlocked && vault.exists ? (
        <footer className="hs-footer">
          <Callout tone="warn">
            The vault is locked, so credential-bearing rules are not being applied.
          </Callout>
        </footer>
      ) : null}
    </div>
  );
}
