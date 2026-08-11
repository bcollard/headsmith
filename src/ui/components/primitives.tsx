/* Small shared controls.
 *
 * Hand-rolled rather than pulled from a component library: the runtime
 * dependency list is four packages and every addition ships to users, so a
 * toggle worth twenty lines does not justify one.
 */

import type { ReactNode, ReactElement, InputHTMLAttributes } from 'react';
import { cloneElement, isValidElement, useId, useState } from 'react';

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="hs-toggle">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>
        {label}
        {hint ? <span className="hs-hint">{hint}</span> : null}
      </label>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  /* The control is associated by id rather than by being nested inside the
     <label>, because everything inside a label contributes to the control's
     accessible name -- including, for a <textarea>, its own value. Nesting
     announced this field as "Domains api.example.com", growing as the user
     typed. Wrapping bit twice (first the hint, then the value), which is the
     signal that the pattern was wrong rather than that it needed another
     exception.

     The hint is linked with aria-describedby, so it is available on request
     without becoming part of the name. */
  const id = useId();
  const hintId = `${id}-hint`;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: (children.props as { id?: string }).id ?? id,
        ...(hint && !error ? { 'aria-describedby': hintId } : {}),
      })
    : children;

  return (
    <div className="hs-field">
      <label className="hs-field-label" htmlFor={id}>
        {label}
      </label>
      {control}
      {error ? <span className="hs-field-error">{error}</span> : null}
      {hint && !error ? (
        <span className="hs-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`hs-btn hs-btn-${variant} ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`hs-input ${props.className ?? ''}`} />;
}

/* A newline- or comma-separated list edited as free text.
 *
 * Deliberately not a tag widget with individual delete buttons: these lists
 * are usually pasted in bulk from somewhere else, and a textarea makes that a
 * paste rather than a dozen interactions.
 *
 * The subtlety is that the parsed value and the text being typed are not the
 * same thing, and the component must hold both. Binding the textarea directly
 * to `value.join('\n')` looks right and makes the field impossible to use:
 * pressing Enter produces `"example.com\n"`, which parses to
 * `["example.com"]`, which renders back as `"example.com"` -- the newline is
 * destroyed on the same keystroke that created it, so a second line can never
 * be started. Anything trailing meets the same fate, including the space in
 * the middle of typing "a, b".
 *
 * So the draft text is state, and the parsed list is what gets published. The
 * draft is re-derived only when `value` changes for some reason other than
 * this component's own typing -- switching profile, importing, an edit in
 * another window. */
export function ListInput({
  value,
  onChange,
  placeholder,
  rows = 3,
  /* Field injects these by cloning, so they have to reach the textarea itself
     -- a label whose htmlFor names an id nothing carries associates nothing at
     all, which is worse than the nesting it replaced. */
  id,
  'aria-describedby': describedBy,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
  'aria-describedby'?: string;
}) {
  const [draft, setDraft] = useState(() => value.join('\n'));
  const [published, setPublished] = useState<string[]>(value);

  /* Adjusting state during render rather than in an effect: this is a
     derivation, and doing it in an effect would render one frame of stale
     text first. */
  if (!sameList(value, published)) {
    setPublished(value);
    setDraft(value.join('\n'));
  }

  return (
    <textarea
      className="hs-input hs-textarea"
      id={id}
      aria-describedby={describedBy}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const parsed = text
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
        setPublished(parsed);
        onChange(parsed);
      }}
    />
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

export function Callout({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'danger';
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`hs-callout hs-callout-${tone}`}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hs-empty">{children}</p>;
}
