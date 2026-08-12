/* Where a profile applies.
 *
 * The order of the fields is a nudge, not an accident. Domains come first
 * because they are the cheapest and most precise way to scope a rule:
 * `requestDomains` costs nothing, matches exactly, and satisfies the
 * host-restriction requirement for credentials. URL substrings cost one rule
 * per term. Regexes cost one rule per term out of a budget five times
 * smaller -- 1,000 per rule set against 5,000 for rules generally.
 *
 * The cost is shown rather than explained, because a number next to the field
 * is read and a paragraph about rule budgets is not.
 */

import { RESOURCE_TYPES, type MatchSet, type Profile } from '../../core/schema';
import { describeOrigin, originsForProfile } from '../../core/origins';
import { useHostPermissions } from '../state/useHostPermissions';
import { estimateProfileCost } from '../../core/budget';
import { checkDomains, repairDomains } from '../../core/domains';
import { Button, Callout, Field, ListInput } from './primitives';

/* The popup's scope editor: where a rule applies, and nothing else.
 *
 * Domains and URL-contains cover almost every real case, and both are the
 * things you change while debugging. Regexes, domain exclusions and resource
 * types are set once and rarely revisited, so they stay in the full editor
 * rather than tripling the height of a 420px popup. */
export function CompactMatchEditor({
  match,
  hasCredential,
  onChange,
}: {
  match: MatchSet;
  hasCredential: boolean;
  onChange: (next: MatchSet) => void;
}) {
  const setInclude = (patch: Partial<MatchSet['include']>) =>
    onChange({ ...match, include: { ...match.include, ...patch } });

  const scoped =
    match.include.domains.length > 0 ||
    match.include.urlContains.length > 0 ||
    match.include.urlRegex.length > 0;

  const extras =
    match.include.urlRegex.length + match.exclude.domains.length + match.resourceTypes.length;

  return (
    <div className="hs-match hs-match-compact">
      {!scoped ? (
        <Callout tone={hasCredential ? 'danger' : 'info'}>
          {hasCredential
            ? 'This profile sends a credential but applies everywhere. Name a domain before it can be used.'
            : 'Applies to every request. Add a domain to narrow it.'}
        </Callout>
      ) : null}

      <Field label="Domains" hint="One per line. Subdomains are included automatically.">
        <ListInput
          value={match.include.domains}
          rows={2}
          placeholder={'api.example.com'}
          onChange={(domains) => setInclude({ domains })}
        />
      </Field>

      <DomainProblems
        values={match.include.domains}
        onRepair={(domains) => setInclude({ domains })}
      />

      <Field label="URL contains" hint="One per line. Matched anywhere in the URL.">
        <ListInput
          value={match.include.urlContains}
          rows={2}
          placeholder={'/api/v2'}
          onChange={(urlContains) => setInclude({ urlContains })}
        />
      </Field>

      {extras > 0 ? (
        <p className="hs-hint">
          This profile also uses {extras} scope rule{extras === 1 ? '' : 's'} only shown in the full
          editor.
        </p>
      ) : null}
    </div>
  );
}

/* Chrome accepts several domain spellings that can then never match anything:
 * `*.example.com`, `https://example.com`, `example.com:8080`, a bare `*`. A
 * rule that is accepted and silently does nothing is the worst failure this
 * extension can produce -- the profile looks configured, and there is nowhere
 * to look. Each one has an obvious intended meaning, so the fix is offered
 * rather than the mistake merely reported. */
function DomainProblems({
  values,
  onRepair,
}: {
  values: string[];
  onRepair: (next: string[]) => void;
}) {
  const problems = checkDomains(values);
  if (problems.length === 0) return null;

  const fixable = problems.some((p) => p.suggestion);

  return (
    <Callout tone="warn" title="These will never match">
      <ul>
        {problems.map((problem) => (
          <li key={problem.value}>
            <code>{problem.value}</code> — {problem.message}
          </li>
        ))}
      </ul>
      {fixable ? (
        <Button onClick={() => onRepair(repairDomains(values))}>Fix these</Button>
      ) : null}
    </Callout>
  );
}

export function MatchEditor({
  match,
  hasCredential,
  onChange,
}: {
  match: MatchSet;
  hasCredential: boolean;
  onChange: (next: MatchSet) => void;
}) {
  const cost = estimateProfileCost(match);
  const scoped =
    match.include.domains.length > 0 ||
    match.include.urlContains.length > 0 ||
    match.include.urlRegex.length > 0;

  const setInclude = (patch: Partial<MatchSet['include']>) =>
    onChange({ ...match, include: { ...match.include, ...patch } });

  return (
    <div className="hs-match">
      {!scoped ? (
        <Callout tone={hasCredential ? 'danger' : 'info'}>
          {hasCredential
            ? 'This profile sends a credential but applies everywhere. Name a domain before it can be used.'
            : 'This profile applies to every request. Add a domain to narrow it.'}
        </Callout>
      ) : null}

      <Field
        label="Domains"
        hint="One per line. A domain covers its subdomains automatically, so api.example.com also matches staging.api.example.com — there is no wildcard syntax because none is needed. The cheapest and most precise way to scope a profile."
      >
        <ListInput
          value={match.include.domains}
          placeholder={'api.example.com\nstaging.example.com'}
          onChange={(domains) => setInclude({ domains })}
        />
      </Field>

      <DomainProblems
        values={match.include.domains}
        onRepair={(domains) => setInclude({ domains })}
      />

      <Field label="URL contains" hint="Matched as a substring of the whole URL.">
        <ListInput
          value={match.include.urlContains}
          placeholder={'/api/v2\n/graphql'}
          onChange={(urlContains) => setInclude({ urlContains })}
        />
      </Field>

      <Field
        label="URL matches regex"
        hint="RE2 syntax — no lookahead or lookbehind. Chrome allows 1,000 regex rules in total, so prefer the fields above where they will do."
      >
        <ListInput
          value={match.include.urlRegex}
          placeholder={'^https://[a-z]+\\.example\\.com/v[12]/'}
          onChange={(urlRegex) => setInclude({ urlRegex })}
        />
      </Field>

      <Field
        label="Except these domains"
        hint="Applied inside this profile's own condition, so it affects nothing else."
      >
        <ListInput
          value={match.exclude.domains}
          placeholder={'cdn.example.com'}
          onChange={(domains) => onChange({ ...match, exclude: { domains } })}
        />
      </Field>

      <fieldset className="hs-resource-types">
        <legend>Request types</legend>
        <p className="hs-hint">Leave all unticked to apply to every type.</p>
        <div className="hs-checkgrid">
          {RESOURCE_TYPES.map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={match.resourceTypes.includes(type)}
                onChange={(e) =>
                  onChange({
                    ...match,
                    resourceTypes: e.target.checked
                      ? [...match.resourceTypes, type]
                      : match.resourceTypes.filter((t) => t !== type),
                  })
                }
              />
              <span>{type.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="hs-cost">
        Costs {cost.rules} rule{cost.rules === 1 ? '' : 's'}
        {cost.regexRules > 0
          ? `, ${cost.regexRules} of them from the smaller regex budget`
          : ''}
        .
      </p>
    </div>
  );
}

/* The grant control.
 *
 * Shown wherever a profile's scope is edited, in both the popup and the full
 * editor, because the moment you name a domain is the moment the question
 * arises. Deliberately not a modal or a first-run wizard: a permission prompt
 * makes sense next to the thing that needs it and nowhere else.
 */
export function HostAccess({ profile }: { profile: Profile }) {
  const need = originsForProfile(profile);
  const { granted, busy, request } = useHostPermissions(need);

  if (need.origins.length === 0) return null;
  if (granted === null) return null;

  if (granted) {
    return (
      <p className="hs-hint hs-granted">
        ✓ Access granted for {need.needsAllUrls ? 'every site' : listHosts(need.origins)}.
      </p>
    );
  }

  return (
    <Callout tone={profile.enabled ? 'warn' : 'info'} title="This profile needs your permission">
      {need.needsAllUrls ? (
        <>
          <p>
            Scoped by URL text or a regular expression rather than a domain, this profile could
            match any site — so Chrome can only offer access to <strong>all sites</strong>.
          </p>
          <p className="hs-hint">
            Naming a domain above asks for that domain alone instead, which is worth doing if
            you can.
          </p>
        </>
      ) : (
        <p>
          Chrome will ask you to allow {listHosts(need.origins)}. Nothing else is requested, and
          you can withdraw it at any time from Chrome&apos;s extension settings.
        </p>
      )}
      <Button variant="primary" onClick={() => void request()} disabled={busy}>
        {busy ? 'Waiting for Chrome…' : need.needsAllUrls ? 'Allow all sites' : 'Allow these sites'}
      </Button>
    </Callout>
  );
}

function listHosts(origins: readonly string[]): string {
  const names = origins.map(describeOrigin);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
