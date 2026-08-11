/* The rule compiler: config in, declarativeNetRequest rules out.
 *
 * This is the file whose output the JSON fixtures pin, because "did my
 * refactor change the rules the browser gets?" is the question that actually
 * matters and it is not answerable by reading a diff.
 *
 * Two properties are worth stating up front, because both reference projects
 * get one of them wrong.
 *
 * ## Bucketing: rules are per condition, not per header
 *
 * FlexHeader emits one rule per header per filter. A profile with 12 headers
 * and 8 URL filters becomes 96 rules. Headsmith groups every header sharing a
 * condition into one rule's `requestHeaders` array, so the same profile
 * becomes 8. With a hard ceiling of 5,000 unsafe rules -- and `modifyHeaders`
 * is unsafe -- that difference decides whether a realistic setup fits.
 *
 * ## Exclusion: `allow` is global, and pretending otherwise is a footgun
 *
 * A DNR `allow` rule at higher priority suppresses *every* lower-priority rule
 * from every profile, not just the profile it was configured on. OpenModHeader
 * emits per-profile exclusions as bare `allow` rules, so one profile's
 * exclusion silently disables the others on that URL. Headsmith puts URL
 * exclusions at config level and labels them "never modify these URLs", which
 * is what the mechanism actually does. Per-profile exclusion is offered only
 * as `exclude.domains`, which compiles to `excludedRequestDomains` inside the
 * condition and so really is scoped to that profile.
 */

import { planProfile, type ProfilePlan, type PlannedOp, type SecretResolver } from './plan';
import { evaluateProfile, type Verdict } from './policy';
import { RESOURCE_TYPES, type Config, type MatchSet, type Profile } from './schema';

/* Higher number wins in declarativeNetRequest. The gap between them is
   deliberate: it leaves room to insert a band without renumbering, and it
   makes an accidental collision obvious in a fixture diff. */
export const PRIORITY = {
  modifyHeaders: 1,
  /** Global "never touch this URL". Must outrank every modify rule. */
  allow: 100,
} as const;

export interface HeaderEntry {
  header: string;
  operation: PlannedOp['operation'];
  value?: string;
}

export interface CompiledRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders' | 'allow';
    requestHeaders?: HeaderEntry[];
    responseHeaders?: HeaderEntry[];
  };
  condition: Record<string, unknown>;
}

/** A rule plus the provenance the worker needs for error reporting. */
export interface AnnotatedRule extends CompiledRule {
  /** Never included in what is sent to Chrome. */
  readonly __profile?: string;
}

export interface BlockedProfile {
  readonly profileId: string;
  readonly profileName: string;
  readonly verdict: Verdict;
}

export interface CompileResult {
  /** Non-credential rules. Persist across browser restarts. */
  readonly dynamic: readonly AnnotatedRule[];
  /** Credential-bearing rules. Session-scoped, so they never touch disk. */
  readonly session: readonly AnnotatedRule[];
  /** Profiles whose credential half was withheld, and why. */
  readonly blocked: readonly BlockedProfile[];
  /** Operations dropped because Chrome would have rejected them. */
  readonly problems: readonly { profileId: string; header: string; detail: string }[];
}

export interface CompileOptions {
  /** Resolves a secret id to its value. Omit to compile with no credentials. */
  readonly resolve?: SecretResolver | null;
  /** False when the vault is locked. */
  readonly unlocked?: boolean;
  /** Secret ids that resolved, for the policy gate. */
  readonly resolvedIds?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

/* Builds the condition list for a match set.
 *
 * `requestDomains` and `excludedRequestDomains` are folded into a shared base
 * because they cost nothing and narrow precisely. `urlFilter` and
 * `regexFilter` each need their own condition -- DNR takes one of each per
 * rule, not a list -- which is why they are the expensive axis and why the
 * editor nudges toward domains.
 *
 * With no include terms at all, the single base condition matches every
 * request within the domain restriction, which is exactly what "apply
 * everywhere" should mean. Note this is not FlexHeader's `regexFilter: "|http*"`
 * catch-all: that spends one of the 1,000 regex slots per header for something
 * an empty condition expresses for free. */
export function conditionsFor(match: MatchSet): Record<string, unknown>[] {
  const base: Record<string, unknown> = {
    resourceTypes: match.resourceTypes.length ? [...match.resourceTypes] : [...RESOURCE_TYPES],
  };
  if (match.include.domains.length) base['requestDomains'] = [...match.include.domains];
  if (match.exclude.domains.length) base['excludedRequestDomains'] = [...match.exclude.domains];

  const conditions: Record<string, unknown>[] = [];
  for (const value of match.include.urlContains) conditions.push({ ...base, urlFilter: value });
  for (const value of match.include.urlRegex) conditions.push({ ...base, regexFilter: value });
  if (conditions.length === 0) conditions.push(base);

  return conditions;
}

function toEntry(op: PlannedOp): HeaderEntry {
  const entry: HeaderEntry = { header: op.header, operation: op.operation };
  // `remove` must not carry a value; Chrome rejects the rule if it does.
  if (op.operation !== 'remove') entry.value = op.value ?? '';
  return entry;
}

/* ------------------------------------------------------------------ *
 * Compilation
 * ------------------------------------------------------------------ */

export function compile(config: Config, options: CompileOptions = {}): CompileResult {
  const { resolve = null, unlocked = true, resolvedIds } = options;

  const dynamic: AnnotatedRule[] = [];
  const session: AnnotatedRule[] = [];
  const blocked: BlockedProfile[] = [];
  const problems: { profileId: string; header: string; detail: string }[] = [];

  if (config.paused) return { dynamic, session, blocked, problems: [] };

  let dynamicId = 1;
  let sessionId = 1;

  for (const profile of config.profiles) {
    if (!profile.enabled) continue;

    const verdict = evaluateProfile(profile, config.settings, {
      unlocked,
      resolvedIds,
    });
    const plan = planProfile(profile, resolve);

    for (const { header, problem } of plan.problems) {
      problems.push({ profileId: profile.id, header, detail: problem.kind });
    }

    if (verdict.hasSensitive && verdict.blocked) {
      blocked.push({ profileId: profile.id, profileName: profile.name, verdict });
    }

    const conditions = conditionsFor(profile.match);

    /* Split by sensitivity, then emit at most one rule per condition per
       class. The plain half is emitted even when the credential half is
       blocked -- a locked vault should not stop an unrelated `X-Debug` header
       in the same profile from working. */
    const plainRequest = plan.requestOps.filter((op) => !op.sensitive).map(toEntry);
    const plainResponse = plan.responseOps.filter((op) => !op.sensitive).map(toEntry);
    emit(dynamic, conditions, plainRequest, plainResponse, () => dynamicId++, profile);

    if (!verdict.blocked) {
      const secretRequest = plan.requestOps.filter((op) => op.sensitive).map(toEntry);
      const secretResponse = plan.responseOps.filter((op) => op.sensitive).map(toEntry);
      /* Credentials only ever become session rules. Session rules live in
         memory for the life of the browser process and are never written to
         disk, which is what makes "a credential never touches disk
         unencrypted" true of the rule set as well as of storage. */
      emit(session, conditions, secretRequest, secretResponse, () => sessionId++, profile);
    }
  }

  /* Global exclusions last, at the top priority band. Emitted after the modify
     rules purely so the ids read in a sensible order in a fixture. */
  for (const value of config.exclusions.urlContains) {
    dynamic.push({
      id: dynamicId++,
      priority: PRIORITY.allow,
      action: { type: 'allow' },
      condition: { urlFilter: value, resourceTypes: [...RESOURCE_TYPES] },
    });
  }
  for (const value of config.exclusions.urlRegex) {
    dynamic.push({
      id: dynamicId++,
      priority: PRIORITY.allow,
      action: { type: 'allow' },
      condition: { regexFilter: value, resourceTypes: [...RESOURCE_TYPES] },
    });
  }

  return { dynamic, session, blocked, problems };
}

function emit(
  bucket: AnnotatedRule[],
  conditions: readonly Record<string, unknown>[],
  requestHeaders: HeaderEntry[],
  responseHeaders: HeaderEntry[],
  nextId: () => number,
  profile: Profile,
): void {
  if (requestHeaders.length === 0 && responseHeaders.length === 0) return;

  for (const condition of conditions) {
    const action: CompiledRule['action'] = { type: 'modifyHeaders' };
    if (requestHeaders.length) action.requestHeaders = requestHeaders.map((h) => ({ ...h }));
    if (responseHeaders.length) action.responseHeaders = responseHeaders.map((h) => ({ ...h }));

    bucket.push({
      id: nextId(),
      priority: PRIORITY.modifyHeaders,
      action,
      condition: { ...condition },
      __profile: profile.name,
    });
  }
}

/* Strips the provenance annotation. Everything handed to Chrome goes through
   here -- an unknown key makes declarativeNetRequest reject the whole batch. */
export function stripMeta(rule: AnnotatedRule): CompiledRule {
  const { __profile: _unused, ...clean } = rule;
  return clean;
}

export function forChrome(rules: readonly AnnotatedRule[]): CompiledRule[] {
  return rules.map(stripMeta);
}

/* Re-exported so callers do not need to know the planner exists. */
export type { ProfilePlan, PlannedOp };
