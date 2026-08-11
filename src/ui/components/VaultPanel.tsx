/* Vault and credential-storage settings.
 *
 * The mode choice is presented in terms of the trade the user is actually
 * making -- retyping after a restart versus a passphrase to remember -- rather
 * than in terms of the cryptography, which is not the part they are deciding
 * about.
 */

import { useState } from 'react';
import type { Config, Settings } from '../../core/schema';
import { Button, Callout, Field, TextInput, Toggle } from './primitives';
import type { VaultState } from '../state/useVault';

const LOCK_CHOICES = [1, 5, 15, 30, 60, 240];

export function VaultPanel({
  config,
  vault,
  onSettings,
}: {
  config: Config;
  vault: VaultState;
  onSettings: (patch: Partial<Settings>) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [rotating, setRotating] = useState(false);
  const [current, setCurrent] = useState('');

  const settings = config.settings;
  const vaultMode = settings.credentialStorage === 'vault';

  return (
    <section className="hs-panel">
      <h2>Credentials</h2>

      {!vault.sessionStorage ? (
        <Callout tone="danger" title="Session storage is unavailable">
          Credentials cannot be held in this browser session. Restart Chrome.
        </Callout>
      ) : null}

      {vault.error ? <Callout tone="danger">{vault.error}</Callout> : null}

      <div className="hs-modes">
        <label className={`hs-mode${!vaultMode ? ' hs-mode-on' : ''}`}>
          <input
            type="radio"
            name="mode"
            checked={!vaultMode}
            onChange={() =>
              void vault.setMode('session', settings).then((ok) => {
                if (ok) onSettings({ credentialStorage: 'session' });
              })
            }
          />
          <span>
            <strong>Session only</strong>
            <span className="hs-hint">
              Credentials are held in memory and cleared when Chrome closes. Nothing is written to
              disk. You enter them again after a restart.
            </span>
          </span>
        </label>

        <label className={`hs-mode${vaultMode ? ' hs-mode-on' : ''}`}>
          <input
            type="radio"
            name="mode"
            checked={vaultMode}
            disabled={!vault.exists}
            onChange={() =>
              void vault.setMode('vault', settings).then((ok) => {
                if (ok) onSettings({ credentialStorage: 'vault' });
              })
            }
          />
          <span>
            <strong>Encrypted vault</strong>
            <span className="hs-hint">
              Credentials are encrypted on disk with a passphrase and survive a restart. AES-GCM
              under a PBKDF2-derived key.
              {!vault.exists ? ' Create a vault below to use this.' : ''}
            </span>
          </span>
        </label>
      </div>

      {!vault.exists ? (
        <div className="hs-vault-create">
          <h3>Create a vault</h3>
          <Callout tone="warn">
            There is no recovery. If you forget this passphrase the stored credentials cannot be
            decrypted by anyone, including us — you would reset the vault and enter them again.
          </Callout>
          <Field label="Passphrase">
            <TextInput
              type="password"
              value={passphrase}
              autoComplete="new-password"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
          <Field
            label="Confirm passphrase"
            error={
              confirmation && confirmation !== passphrase ? 'These do not match.' : null
            }
          >
            <TextInput
              type="password"
              value={confirmation}
              autoComplete="new-password"
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!passphrase || passphrase !== confirmation || vault.busy}
            onClick={() =>
              void vault.create(passphrase).then((ok) => {
                if (ok) {
                  setPassphrase('');
                  setConfirmation('');
                }
              })
            }
          >
            {vault.busy ? 'Deriving key…' : 'Create vault'}
          </Button>
        </div>
      ) : (
        <div className="hs-vault-state">
          <p>
            The vault is <strong>{vault.unlocked ? 'unlocked' : 'locked'}</strong>.
          </p>

          {vault.unlocked ? (
            <Button onClick={() => void vault.lock()}>Lock now</Button>
          ) : (
            <form
              className="hs-unlock"
              onSubmit={(e) => {
                e.preventDefault();
                void vault.unlock(passphrase).then((ok) => ok && setPassphrase(''));
              }}
            >
              <TextInput
                type="password"
                value={passphrase}
                placeholder="Passphrase"
                autoComplete="current-password"
                aria-label="Passphrase"
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={!passphrase || vault.busy}>
                {vault.busy ? 'Unlocking…' : 'Unlock'}
              </Button>
            </form>
          )}

          {vaultMode ? (
            <>
              <Toggle
                checked={!settings.disableAutoLock}
                onChange={(on) => onSettings({ disableAutoLock: !on })}
                label="Lock automatically when idle"
                hint="Deliberate activity — editing or unlocking — pushes the deadline out. Network traffic does not, so a background poller cannot hold the vault open."
              />
              {!settings.disableAutoLock ? (
                <Field label="Lock after">
                  <select
                    className="hs-input hs-select"
                    value={settings.lockAfterMinutes}
                    onChange={(e) => onSettings({ lockAfterMinutes: Number(e.target.value) })}
                  >
                    {LOCK_CHOICES.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hours`}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {rotating ? (
                <div className="hs-rotate">
                  <Field label="Current passphrase">
                    <TextInput
                      type="password"
                      value={current}
                      autoComplete="current-password"
                      onChange={(e) => setCurrent(e.target.value)}
                    />
                  </Field>
                  <Field label="New passphrase">
                    <TextInput
                      type="password"
                      value={passphrase}
                      autoComplete="new-password"
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="primary"
                    disabled={!current || !passphrase || vault.busy}
                    onClick={() =>
                      void vault.changePassphrase(current, passphrase).then((ok) => {
                        if (ok) {
                          setCurrent('');
                          setPassphrase('');
                          setRotating(false);
                        }
                      })
                    }
                  >
                    {vault.busy ? 'Re-encrypting…' : 'Change passphrase'}
                  </Button>
                  <Button variant="ghost" onClick={() => setRotating(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setRotating(true)}>
                  Change passphrase
                </Button>
              )}
            </>
          ) : null}
        </div>
      )}

      <hr />

      <Toggle
        checked={settings.requireExplicitHosts}
        onChange={(on) => onSettings({ requireExplicitHosts: on })}
        label="Credentials require a scope"
        hint="A profile that sends a credential must name a domain or URL first, so a token cannot be attached to every request your browser makes. Individual profiles can override this."
      />
      <Toggle
        checked={settings.warnOnInsecureHosts}
        onChange={(on) => onSettings({ warnOnInsecureHosts: on })}
        label="Warn when a credential targets http://"
        hint="Loopback and .local addresses are exempt."
      />
    </section>
  );
}
