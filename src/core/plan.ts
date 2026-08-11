/* Turns a profile into the header operations it implies, resolving credentials
 * on the way.
 *
 * Derived from OpenModHeader's chromium/common.js (planProfile).
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * The fail-closed credential-resolution structure is upstream's. See NOTICE.md.
 *
 * Separate from the compiler because the two answer different questions.
 * The planner answers "what should happen to which headers", which is where
 * credential resolution and fail-closed behaviour live. The compiler answers
 * "what rules express that", which is where Chrome's constraints live. Keeping
 * them apart means the fail-closed logic can be tested without reasoning about
 * rule ids and priorities.
 *
 * The fail-closed rule, stated once: an operation whose credential cannot be
 * resolved is dropped. It is never emitted with an empty value. A request
 * carrying `Authorization:` with nothing after it is worse than a request
 * carrying no `Authorization` at all -- the first looks like an authentication
 * attempt to the server and may lock an account or burn a rate limit; the
 * second is simply unauthenticated.
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
  /** Whether this op carries a credential, and so must go to a session rule. */
  readonly sensitive: boolean;
}

export interface ProfilePlan {
  readonly requestOps: readonly PlannedOp[];
  readonly responseOps: readonly PlannedOp[];
  /** Secret ids that were referenced but did not resolve. */
  readonly missingSecretIds: readonly string[];
  /** Sensitive headers carrying no secret reference at all. */
  readonly unmanagedHeaders: readonly string[];
  /** Operations Chrome would reject, dropped before it sees them. */
  readonly problems: readonly { header: string; problem: OperationProblem }[];
}

/** Returns the credential for a secret id, or null/undefined if unavailable. */
export type SecretResolver = (secretId: string) => string | null | undefined;

function isLive(header: HeaderOp): boolean {
  return header.enabled && header.name.trim().length > 0;
}

export function planProfile(profile: Profile, resolve: SecretResolver | null = null): ProfilePlan {
  const missingSecretIds = new Set<string>();
  const unmanagedHeaders = new Set<string>();
  const problems: { header: string; problem: OperationProblem }[] = [];

  const planList = (headers: readonly HeaderOp[], target: 'request' | 'response'): PlannedOp[] => {
    const out: PlannedOp[] = [];

    for (const header of headers) {
      if (!isLive(header)) continue;

      /* Dropped here rather than handed to Chrome: one invalid rule makes
         declarativeNetRequest reject the entire batch, so a single typo would
         take every other rule in the profile down with it. */
      const problem = checkOperation(header, target);
      if (problem) {
        problems.push({ header: header.name, problem });
        continue;
      }

      const name = header.name.trim().toLowerCase();

      if (header.operation === 'remove') {
        // No value involved, so no credential to resolve.
        out.push({ header: name, operation: 'remove', sensitive: false });
        continue;
      }

      const sensitive = carriesCredential(header);

      if (!sensitive) {
        out.push({ header: name, operation: header.operation, value: header.value, sensitive: false });
        continue;
      }

      /* A credential-bearing header with no secret reference is unmanaged.
         Its inline value -- if a hand-edited config gave it one -- is dropped
         rather than sent. */
      if (!header.secretId) {
        unmanagedHeaders.add(header.name);
        continue;
      }

      const value = resolve ? resolve(header.secretId) : undefined;
      if (value == null || value === '') {
        missingSecretIds.add(header.secretId);
        continue;
      }

      out.push({ header: name, operation: header.operation, value, sensitive: true });
    }

    return out;
  };

  return {
    requestOps: planList(profile.requestHeaders, 'request'),
    responseOps: planList(profile.responseHeaders, 'response'),
    missingSecretIds: [...missingSecretIds],
    unmanagedHeaders: [...unmanagedHeaders],
    problems,
  };
}

export function planIsEmpty(plan: ProfilePlan): boolean {
  return plan.requestOps.length === 0 && plan.responseOps.length === 0;
}

/* How many header operations a config would apply, for the toolbar badge. */
export function countActiveOps(
  profiles: readonly Profile[],
  paused: boolean,
  resolve: SecretResolver | null = null,
): number {
  if (paused) return 0;
  return profiles.reduce((total, profile) => {
    if (!profile.enabled) return total;
    const plan = planProfile(profile, resolve);
    return total + plan.requestOps.length + plan.responseOps.length;
  }, 0);
}
