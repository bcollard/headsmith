/* What the browser is actually doing, as opposed to what is configured.
 *
 * The gap between those two is where this extension's confusing failures live:
 * a profile that looks right but is withheld because the vault is locked, a
 * rule the engine refused, a header dropped because Chrome will not append to
 * it. Each of those is silent unless something says so.
 *
 * Rule errors come from storage, written by the worker, and name headers only
 * -- never values, since a rejected rule may carry a credential.
 */

import { describeBlock, type BlockReason } from '../../core/policy';
import { describeOrigin } from '../../core/origins';
import { LIMITS } from '../../core/budget';
import { describeProblem } from '../../core/sensitivity';
import type { Status } from '../../background/store';
import { Callout } from './primitives';

export function StatusBar({
  status,
  pending,
  paused,
}: {
  status: Status | null;
  pending: boolean;
  paused: boolean;
}) {
  if (!status) return null;

  const { budget, blocked, problems, ruleErrors } = status;
  const total = budget.dynamic + budget.session;
  const tight = budget.pressure > 0.7;

  return (
    <div className="hs-status">
      {paused ? (
        <Callout tone="warn" title="Headsmith is paused">
          No rules are being applied. Press Alt+Shift+H or use the toggle to resume.
        </Callout>
      ) : null}

      {ruleErrors.length > 0 ? (
        <Callout tone="danger" title="Chrome refused some rules">
          <ul>
            {ruleErrors.map((error) => (
              <li key={error}>
                <code>{error}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {status.missingPermissions.length > 0 ? (
        <Callout tone="warn" title="Waiting on your permission">
          <ul>
            {status.missingPermissions.map((gap) => (
              <li key={gap.profileId}>
                <strong>{gap.profileName}</strong>{' '}
                {gap.needsAllUrls
                  ? 'needs access to every site, because it is scoped by URL text rather than a domain.'
                  : `needs access to ${gap.origins.map(describeOrigin).join(', ')}.`}
                {gap.hasCredential ? ' Its credential is not being sent.' : ''}
              </li>
            ))}
          </ul>
          <p className="hs-hint">Open Scope to grant it. Chrome will ask you to confirm.</p>
        </Callout>
      ) : null}

      {blocked.length > 0 ? (
        <Callout tone="warn" title="Some credentials are not being sent">
          <ul>
            {blocked.map((entry) => (
              <li key={entry.profileId}>
                <strong>{entry.profileName}</strong>{' '}
                {describeBlock(entry.reasons as BlockReason[])}
              </li>
            ))}
          </ul>
          <p className="hs-hint">
            The rest of each profile still applies — only the credential-bearing half is
            withheld.
          </p>
        </Callout>
      ) : null}

      {problems.length > 0 ? (
        <Callout tone="warn" title="Some headers were skipped">
          <ul>
            {problems.map((problem, i) => (
              <li key={`${problem.profileId}-${problem.header}-${i}`}>
                <code>{problem.header}</code> —{' '}
                {describeProblem({
                  kind: problem.detail as 'append-not-allowed',
                  header: problem.header,
                })}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {budget.breaches.length > 0 ? (
        <Callout tone="danger" title="Over Chrome's rule limit">
          <ul>
            {budget.breaches.map((breach) => (
              <li key={breach}>{breach}</li>
            ))}
          </ul>
          <p className="hs-hint">
            Replacing URL filters with domain filters is usually the cheapest fix.
          </p>
        </Callout>
      ) : null}

      <p className="hs-status-line">
        {pending ? (
          <span className="hs-status-pending">Saving…</span>
        ) : (
          <>
            <strong>{total}</strong> rule{total === 1 ? '' : 's'} active
            {tight ? (
              <span className="hs-status-tight">
                {' '}
                — {Math.round(budget.pressure * 100)}% of Chrome's limit ({LIMITS.unsafeDynamic}{' '}
                rules, {LIMITS.regexPerRuleSet} of them regex)
              </span>
            ) : null}
          </>
        )}
      </p>
    </div>
  );
}
