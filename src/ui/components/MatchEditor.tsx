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

import { RESOURCE_TYPES, type MatchSet } from '../../core/schema';
import { estimateProfileCost } from '../../core/budget';
import { Callout, Field, ListInput } from './primitives';

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
        hint="api.example.com — matches the domain and its subdomains. The cheapest and most precise option."
      >
        <ListInput
          value={match.include.domains}
          placeholder={'api.example.com\nstaging.example.com'}
          onChange={(domains) => setInclude({ domains })}
        />
      </Field>

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
