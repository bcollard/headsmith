/* Turns a profile into the header operations it implies, resolving credentials
 * on the way.
 *
 * The fail-closed principle stated below is OpenModHeader's (MIT, (c) 2026
 * Shiva M). See NOTICE.md.
 *
 * Separate from the compiler because the two answer different questions. This
 * answers "what should happen to which headers", which is where credential
 * resolution lives. The compiler answers "what rules express that", which is
 * where Chrome's constraints live. Keeping them apart means the fail-closed
 * behaviour can be tested without reasoning about rule ids and priorities.
 *
 * ## The fail-closed rule
 *
 * An operation whose credential cannot be resolved is **dropped**. It is never
 * emitted with an empty value.
 *
 * This is not fastidiousness. A request carrying `Authorization:` with nothing
 * after it is materially worse than a request carrying no `Authorization` at
 * all: the server reads it as a failed authentication attempt, which can burn
 * a rate limit, trip a lockout, or page somebody. Absent means unauthenticated;
 * empty means wrong.
 *
 * ## Shape
 *
 * Each header is classified into exactly one outcome, and the outcomes are
 * partitioned afterwards. The alternative -- a loop pushing into several
 * accumulator arrays as it goes -- makes "can a header be both emitted and
 * reported missing?" a question you answer by reading the whole loop. Here it
 * is answered by the type.
 */

import { carriesCredential, checkOperation, type OperationProblem } from './sensitivity';
import type { HeaderOp, Profile } from './schema';

/** A resolved header operation, ready to become a DNR header entry. */
export interface PlannedOp {
  /** Lowercased, as Chrome requires. */
  readonly header: string;
  readonly operation: HeaderOp['operation'];
  /** Absent for `remove`. */
  readonly value?: string;
  /** Carries a credential, and so must be routed to a session rule. */
  readonly sensitive: boolean;
}

/** Exactly one of these per live header. */
type Outcome =
  | { kind: 'emit'; op: PlannedOp }
  | { kind: 'rejected'; header: string; problem: OperationProblem }
  | { kind: 'unresolved'; secretId: string }
  | { kind: 'unmanaged'; header: string };

export interface ProfilePlan {
  readonly requestOps: readonly PlannedOp[];
  readonly responseOps: readonly PlannedOp[];
  /** Secret ids referenced but not resolvable. */
  readonly missingSecretIds: readonly string[];
  /** Credential-bearing headers carrying no secret reference at all. */
  readonly unmanagedHeaders: readonly string[];
  /** Operations Chrome would reject, dropped before it sees them. */
  readonly problems: readonly { header: string; problem: OperationProblem }[];
}

/** Returns the credential for a secret id, or null/undefined if unavailable. */
export type SecretResolver = (secretId: string) => string | null | undefined;

function isLive(header: HeaderOp): boolean {
  return header.enabled && header.name.trim().length > 0;
}

/* Classifies one header. Total: every path returns an Outcome, so a header can
   never be silently neither emitted nor accounted for. */
function classify(
  header: HeaderOp,
  target: 'request' | 'response',
  resolve: SecretResolver | null,
): Outcome {
  /* Checked before anything else, because Chrome rejects the entire batch on
     one malformed rule -- a single typo would take every other rule in the
     profile down with it. */
  const problem = checkOperation(header, target);
  if (problem) return { kind: 'rejected', header: header.name, problem };

  const name = header.name.trim().toLowerCase();

  if (header.operation === 'remove') {
    // No value, so no credential to resolve and nothing to leak.
    return { kind: 'emit', op: { header: name, operation: 'remove', sensitive: false } };
  }

  if (!carriesCredential(header)) {
    return {
      kind: 'emit',
      op: { header: name, operation: header.operation, value: header.value, sensitive: false },
    };
  }

  /* Credential-bearing from here down. */
  if (header.secretId === null) return { kind: 'unmanaged', header: header.name };

  const value = resolve?.(header.secretId);
  /* An empty string is treated as unresolved, not as a valid credential: it is
     the failure mode, not a value anyone means to send. */
  if (value === null || value === undefined || value === '') {
    return { kind: 'unresolved', secretId: header.secretId };
  }

  return {
    kind: 'emit',
    op: { header: name, operation: header.operation, value, sensitive: true },
  };
}

export function planProfile(profile: Profile, resolve: SecretResolver | null = null): ProfilePlan {
  const request = profile.requestHeaders.filter(isLive).map((h) => classify(h, 'request', resolve));
  const response = profile.responseHeaders
    .filter(isLive)
    .map((h) => classify(h, 'response', resolve));
  const all = [...request, ...response];

  const emitted = (outcomes: Outcome[]): PlannedOp[] =>
    outcomes.flatMap((o) => (o.kind === 'emit' ? [o.op] : []));

  return {
    requestOps: emitted(request),
    responseOps: emitted(response),
    missingSecretIds: [
      ...new Set(all.flatMap((o) => (o.kind === 'unresolved' ? [o.secretId] : []))),
    ],
    unmanagedHeaders: [...new Set(all.flatMap((o) => (o.kind === 'unmanaged' ? [o.header] : [])))],
    problems: all.flatMap((o) =>
      o.kind === 'rejected' ? [{ header: o.header, problem: o.problem }] : [],
    ),
  };
}

export function planIsEmpty(plan: ProfilePlan): boolean {
  return plan.requestOps.length === 0 && plan.responseOps.length === 0;
}

/* How many header operations a config would actually apply, for the toolbar
   badge. Counts what survives planning, not what is configured -- a badge
   claiming a credential rule is active while it is being withheld would be
   worse than no badge. */
export function countActiveOps(
  profiles: readonly Profile[],
  paused: boolean,
  resolve: SecretResolver | null = null,
): number {
  if (paused) return 0;
  return profiles
    .filter((profile) => profile.enabled)
    .reduce((total, profile) => {
      const plan = planProfile(profile, resolve);
      return total + plan.requestOps.length + plan.responseOps.length;
    }, 0);
}
