/* Global exclusions, import and export.
 *
 * Export carries no credentials, and not because it filters them out: a
 * sensitive header holds a reference rather than a value, so the config object
 * has nothing to leak. The file is safe to paste into a ticket. It is also
 * therefore incomplete -- whoever imports it enters the credentials
 * themselves, which the UI says plainly rather than letting them discover it
 * when a request fails.
 */

import { useRef, useState } from 'react';
import { parseConfig, type Config } from '../../core/schema';
import { migrate } from '../../core/migrations';
import { collectSecretIds } from '../../core/schema';
import { Button, Callout, Field, ListInput } from './primitives';

export function SettingsPanel({
  config,
  onChange,
  onReplace,
}: {
  config: Config;
  onChange: (fn: (config: Config) => Config) => void;
  onReplace: (next: Config) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `headsmith-config-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = async (file: File) => {
    setImportError(null);
    setImported(null);
    try {
      const text = await file.text();
      /* Run migrations, then parse. An exported config may come from an older
         version, and the tolerant parser alone would silently drop renamed
         fields rather than carrying them across. */
      const result = migrate(JSON.parse(text));
      await onReplace(result.config);
      setImported(collectSecretIds(result.config).length);
    } catch (err) {
      setImportError(
        err instanceof SyntaxError
          ? 'That file is not valid JSON.'
          : `Could not import: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <section className="hs-panel">
      <h2>Never modify these URLs</h2>
      <Callout tone="info">
        These apply across every profile. Chrome's exclusion mechanism suppresses all header
        rules for a matching request and cannot be scoped to one profile, so this is deliberately
        a single global list rather than a per-profile setting that would quietly affect the
        others.
      </Callout>

      <Field label="URL contains">
        <ListInput
          value={config.exclusions.urlContains}
          placeholder={'/healthz\n/metrics'}
          onChange={(urlContains) =>
            onChange((c) => ({ ...c, exclusions: { ...c.exclusions, urlContains } }))
          }
        />
      </Field>

      <Field label="URL matches regex">
        <ListInput
          value={config.exclusions.urlRegex}
          placeholder={'\\.(png|jpe?g|gif|woff2?)$'}
          onChange={(urlRegex) =>
            onChange((c) => ({ ...c, exclusions: { ...c.exclusions, urlRegex } }))
          }
        />
      </Field>

      <hr />

      <h2>Import and export</h2>
      <Callout tone="info">
        An exported file contains no credentials — profiles store a reference to a credential,
        never the value itself. Whoever imports it enters their own.
      </Callout>

      <div className="hs-row">
        <Button onClick={exportConfig}>Export configuration</Button>
        <Button onClick={() => fileInput.current?.click()}>Import configuration</Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importConfig(file);
            e.target.value = '';
          }}
        />
      </div>

      {importError ? <Callout tone="danger">{importError}</Callout> : null}
      {imported !== null ? (
        <Callout tone="info" title="Imported">
          {imported === 0
            ? 'No credentials were referenced, so nothing further is needed.'
            : `${imported} credential${imported === 1 ? '' : 's'} referenced. Enter ${
                imported === 1 ? 'its value' : 'their values'
              } before those profiles will apply.`}
        </Callout>
      ) : null}
    </section>
  );
}

/* Reuse the parser's own repair path when a caller needs a valid config from
   something arbitrary. */
export { parseConfig };
