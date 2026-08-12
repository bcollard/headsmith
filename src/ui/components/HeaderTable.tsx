/* The header editor -- where people spend all their time.
 *
 * Two things it has to get right beyond the obvious:
 *
 * 1. **A credential is never typed into the value field.** When a header's
 *    name is recognised as credential-bearing, the value field is replaced by
 *    a secret field that writes into the secret store and leaves only a
 *    reference in the profile. This happens as the name is typed, not on save,
 *    so there is no window in which a token sits in the config object.
 *
 * 2. **Chrome's constraints surface here, not at apply time.** An append on a
 *    header Chrome will not accept, or a malformed name, is reported inline.
 *    Otherwise the whole rule batch is rejected and every other rule in the
 *    profile silently stops working.
 *
 * Reordering is native HTML5 drag and drop rather than a library. Order has no
 * semantic effect -- the compiler groups by condition, not sequence -- so this
 * is purely organisational and does not justify a runtime dependency.
 */

import { useState } from 'react';
import { blankHeaderOp, type HeaderOp, type Settings } from '../../core/schema';
import { checkOperation, describeProblem, isSensitive } from '../../core/sensitivity';
import { Button, TextInput } from './primitives';
import { SecretField } from './SecretField';
import type { VaultState } from '../state/useVault';

const OPERATIONS = ['set', 'append', 'remove'] as const;

export function HeaderTable({
  headers,
  target,
  settings,
  vault,
  onChange,
  onSecretLabel,
}: {
  headers: HeaderOp[];
  target: 'request' | 'response';
  settings: Settings;
  vault: VaultState;
  onChange: (next: HeaderOp[]) => void;
  onSecretLabel: (secretId: string, label: string) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  /* Which row, if any, is currently allowed to be dragged.
   *
   * `draggable` on the row meant a mouse-drag anywhere inside it started a
   * reorder -- including the drag that selects text in a header name or value,
   * which is the single most common thing anyone does in this table. Selecting
   * a token to replace it moved the row instead.
   *
   * HTML5 drag-and-drop has no notion of a handle, so the row is only made
   * draggable once a press lands somewhere that is not a control: the grip, or
   * the row's own surface. Pressing inside an input leaves it undraggable and
   * the browser does its ordinary text selection. */
  const [armed, setArmed] = useState<number | null>(null);

  const replace = (index: number, patch: Partial<HeaderOp>) => {
    onChange(headers.map((h, i) => (i === index ? { ...h, ...patch } : h)));
  };

  const remove = (index: number) => {
    const header = headers[index];
    /* Drop the stored credential too. Leaving it would keep a secret alive
       with nothing referencing it -- pruning would catch it eventually, but
       "eventually" is the wrong guarantee for a credential. */
    if (header?.secretId) void vault.removeSecret(header.secretId);
    onChange(headers.filter((_, i) => i !== index));
  };

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...headers];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="hs-headers">
      {headers.length === 0 ? (
        <p className="hs-empty">No {target} headers yet.</p>
      ) : (
        <ul className="hs-header-list">
          {headers.map((header, index) => {
            const problem = header.name.trim() ? checkOperation(header, target) : null;
            const sensitive = isSensitive(header);

            return (
              <li
                key={header.id}
                className={`hs-header-row${dragging === index ? ' hs-dragging' : ''}`}
                draggable={armed === index}
                /* Arm only when the press did not land on something the user
                   is trying to type in or click. Checked on the event target
                   rather than by wiring handlers onto each control, so a
                   control added later is covered without anyone remembering. */
                onMouseDown={(e) => {
                  const onControl = (e.target as HTMLElement).closest(
                    'input, select, textarea, button, code, a',
                  );
                  setArmed(onControl ? null : index);
                }}
                onMouseUp={() => setArmed(null)}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => {
                  setDragging(null);
                  setArmed(null);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging !== null) move(dragging, index);
                  setDragging(null);
                  setArmed(null);
                }}
              >
                <span
                  className="hs-grip hs-cell-grip"
                  title="Drag to reorder"
                  aria-hidden="true"
                  /* The handle proper. The row surface works too, but this is
                     the part that looks draggable, so it has to be. */
                  onMouseDown={() => setArmed(index)}
                >
                  ⠿
                </span>

                <input
                  className="hs-cell-enabled"
                  type="checkbox"
                  checked={header.enabled}
                  onChange={(e) => replace(index, { enabled: e.target.checked })}
                  title={header.enabled ? 'Enabled' : 'Disabled'}
                  aria-label="Enabled"
                />

                <select
                  className="hs-input hs-select hs-cell-op"
                  value={header.operation}
                  onChange={(e) =>
                    replace(index, { operation: e.target.value as HeaderOp['operation'] })
                  }
                  aria-label="Operation"
                >
                  {OPERATIONS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>

                <TextInput
                  className="hs-cell-name"
                  value={header.name}
                  placeholder="Header-Name"
                  spellCheck={false}
                  aria-label="Header name"
                  onChange={(e) => {
                    const name = e.target.value;
                    /* Detection runs on every keystroke so a value field never
                       holds a credential, not even briefly. */
                    const becameSensitive =
                      !isSensitive(header) && isSensitive({ name, sensitive: header.sensitive });
                    replace(index, {
                      name,
                      ...(becameSensitive ? { value: '' } : {}),
                    });
                  }}
                />

                {header.operation === 'remove' ? (
                  <span className="hs-removed-note hs-cell-value">no value needed</span>
                ) : sensitive ? (
                  <SecretField
                    header={header}
                    settings={settings}
                    vault={vault}
                    onAssign={(secretId) => replace(index, { secretId, value: '' })}
                    onLabel={(label) => header.secretId && onSecretLabel(header.secretId, label)}
                  />
                ) : (
                  <TextInput
                    className="hs-cell-value"
                    value={header.value}
                    placeholder="value"
                    spellCheck={false}
                    aria-label="Header value"
                    onChange={(e) => replace(index, { value: e.target.value })}
                  />
                )}

                <Button
                  className="hs-cell-lock"
                  variant="ghost"
                  title="Mark as a credential"
                  onClick={() => replace(index, { sensitive: !header.sensitive, value: '' })}
                  disabled={isSensitive({ name: header.name, sensitive: false })}
                >
                  {sensitive ? '🔒' : '🔓'}
                </Button>

                <Button
                  className="hs-cell-remove"
                  variant="ghost"
                  title="Remove this header"
                  onClick={() => remove(index)}
                >
                  ✕
                </Button>

                {problem ? (
                  <p className="hs-row-problem">{describeProblem(problem)}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Button onClick={() => onChange([...headers, blankHeaderOp()])}>
        Add {target} header
      </Button>
    </div>
  );
}
