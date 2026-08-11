/* Small shared controls.
 *
 * Hand-rolled rather than pulled from a component library: the runtime
 * dependency list is four packages and every addition ships to users, so a
 * toggle worth twenty lines does not justify one.
 */

import type { ReactNode, InputHTMLAttributes } from 'react';
import { useId } from 'react';

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
  /* The hint and the error sit outside the <label> deliberately. Anything
     inside a label becomes part of the control's accessible name, so nesting
     the hint would announce a control as "Domains api.example.com — matches
     the domain and its subdomains. The cheapest and most precise option."
     A control's name should be its name. */
  return (
    <div className="hs-field">
      <label className="hs-field-label-row">
        <span className="hs-field-label">{label}</span>
        {children}
      </label>
      {error ? <span className="hs-field-error">{error}</span> : null}
      {hint && !error ? <span className="hs-hint">{hint}</span> : null}
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

/* A comma- or newline-separated list edited as free text.
 *
 * Deliberately not a tag widget with individual delete buttons: these lists
 * are usually pasted in bulk from somewhere else, and a textarea makes that a
 * paste rather than a dozen interactions. Parsing is forgiving -- commas,
 * newlines and stray whitespace all work. */
export function ListInput({
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="hs-input hs-textarea"
      rows={rows}
      value={value.join('\n')}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) =>
        onChange(
          e.target.value
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
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
