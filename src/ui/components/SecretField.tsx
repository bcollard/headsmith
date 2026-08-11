/* The credential entry field.
 *
 * Replaces the ordinary value input whenever a header is recognised as
 * credential-bearing. What it types into is the secret store; what the profile
 * keeps is a reference.
 *
 * Deliberate omissions:
 *
 * - **The stored value is never loaded into the field.** Opening the popup
 *   does not put your token in the DOM. The field shows whether a credential
 *   is set, not what it is.
 * - **Revealing requires the passphrase**, and does real cryptographic work
 *   with it -- the key is re-derived and used to authenticate that specific
 *   record. Removing this prompt from the markup would not produce a value.
 * - **In session mode there is nothing to reveal**, because there is no
 *   ciphertext and no passphrase. The UI says so rather than offering a
 *   button that cannot work.
 */

import { useState } from 'react';
import { newSecretId, type HeaderOp, type Settings } from '../../core/schema';
import { Button, TextInput } from './primitives';
import type { VaultState } from '../state/useVault';

export function SecretField({
  header,
  settings,
  vault,
  onAssign,
  onLabel,
}: {
  header: HeaderOp;
  settings: Settings;
  vault: VaultState;
  onAssign: (secretId: string) => void;
  onLabel: (label: string) => void;
}) {
  const [entry, setEntry] = useState('');
  const [editing, setEditing] = useState(!header.secretId);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [askingPassphrase, setAskingPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');

  const vaultMode = settings.credentialStorage === 'vault';
  const blocked = vaultMode && !vault.unlocked;

  const save = async () => {
    if (!entry) return;
    const secretId = header.secretId ?? newSecretId();
    const ok = await vault.saveSecret(secretId, entry, settings);
    if (!ok) return;
    if (!header.secretId) onAssign(secretId);
    onLabel(header.name);
    setEntry('');
    setEditing(false);
    setRevealed(null);
  };

  if (blocked) {
    return (
      <span className="hs-secret hs-cell-value hs-secret-locked">
        Vault locked
      </span>
    );
  }

  if (editing) {
    return (
      <span className="hs-secret hs-cell-value">
        <TextInput
          type="password"
          value={entry}
          placeholder={header.secretId ? 'New value' : 'Credential value'}
          autoComplete="off"
          spellCheck={false}
          aria-label="Credential value"
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape' && header.secretId) setEditing(false);
          }}
        />
        <Button variant="primary" onClick={() => void save()} disabled={!entry || vault.busy}>
          Save
        </Button>
        {header.secretId ? (
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        ) : null}
      </span>
    );
  }

  if (askingPassphrase) {
    return (
      <span className="hs-secret hs-cell-value">
        <TextInput
          type="password"
          value={passphrase}
          placeholder="Passphrase to reveal"
          autoComplete="off"
          aria-label="Passphrase"
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAskingPassphrase(false);
          }}
        />
        <Button
          onClick={async () => {
            if (!header.secretId) return;
            const value = await vault.reveal(header.secretId, passphrase, settings);
            setPassphrase('');
            setAskingPassphrase(false);
            if (value !== null) setRevealed(value);
          }}
          disabled={!passphrase || vault.busy}
        >
          Reveal
        </Button>
        <Button variant="ghost" onClick={() => setAskingPassphrase(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className="hs-secret hs-cell-value">
      <code className="hs-secret-value">{revealed ?? '••••••••••••'}</code>
      <Button variant="ghost" onClick={() => setEditing(true)} title="Replace this credential">
        Replace
      </Button>
      {revealed ? (
        <Button variant="ghost" onClick={() => setRevealed(null)}>
          Hide
        </Button>
      ) : vaultMode ? (
        <Button variant="ghost" onClick={() => setAskingPassphrase(true)} title="Reveal">
          Reveal
        </Button>
      ) : null}
    </span>
  );
}
