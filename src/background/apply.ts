/* Handing compiled rules to the browser.
 *
 * Derived from OpenModHeader's chromium/background.js.
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * The per-rule retry after a batch rejection, the in-flight/queued
 * serialisation, the stripped profile annotation and the header-names-only
 * error strings are upstream's. See NOTICE.md.
 *
 * The compiler decides what the rules are; this decides how they get there.
 * Three things it has to get right:
 *
 * 1. **Atomic replacement.** Each update removes every existing rule in the
 *    set and adds the new ones in the same call, so there is no window where
 *    a request could be matched by a half-applied rule set.
 *
 * 2. **Per-rule fallback.** declarativeNetRequest rejects the *entire batch*
 *    if one rule is malformed. A batch failure therefore retries rule by rule
 *    so the survivors still apply and the offender can be named. Without this
 *    a single bad regex silently disables every rule the user has.
 *
 * 3. **Serialisation.** Rule builds are triggered by storage changes, tab
 *    events and alarms, all of which can arrive together. Overlapping updates
 *    would race on the remove-then-add, so a build in flight sets a flag and
 *    the next request coalesces into a single follow-up run.
 */

import { budgetFor } from '../core/budget';
import { compile, forChrome, type AnnotatedRule, type CompileResult } from '../core/compile';
import { collectSecretIds, type Config } from '../core/schema';
import { badge, dnr, type RuleUpdate } from '../platform/chrome';
import { resolveSecrets, isUnlocked } from './secrets';
import { loadConfig, saveStatus, type Status } from './store';

let running = false;
let queued = false;

/* Applies one bucket, falling back to rule-by-rule on a batch rejection. */
async function applyBucket(
  rules: readonly AnnotatedRule[],
  getExisting: () => Promise<{ id: number }[]>,
  update: (options: RuleUpdate) => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];

  /* Every engine call here is treated as fallible, including the ones that
     "cannot" fail. applyRules is the top of the stack: an uncaught throw
     anywhere below means no rules are applied *and* no status is written, so
     the user sees a silently dead extension with nothing to explain it.
     Quota exhaustion can make even a remove-only call fail. */
  let removeRuleIds: number[] = [];
  try {
    removeRuleIds = (await getExisting()).map((r) => r.id);
  } catch (err) {
    errors.push(`could not read the existing rules — ${reason(err)}`);
  }

  try {
    await update({
      removeRuleIds,
      addRules: forChrome(rules) as chrome.declarativeNetRequest.Rule[],
    });
    return errors;
  } catch {
    /* The batch was rejected. One malformed rule rejects all of them, so retry
       individually: the good rules still land and the offender gets named. */
  }

  try {
    await update({ removeRuleIds });
  } catch (err) {
    /* The set could not be cleared, so stale rules may still be live. Say so
       rather than adding on top of an unknown state. */
    errors.push(`could not clear the previous rules — ${reason(err)}`);
    return errors;
  }

  for (const rule of rules) {
    try {
      await update({ addRules: [...forChrome([rule])] as chrome.declarativeNetRequest.Rule[] });
    } catch (err) {
      errors.push(describe(rule, err));
    }
  }
  return errors;
}

function reason(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, '');
}

/* Describes a rejected rule by header *name* only. A rule that failed may
   carry a credential in its value, and this string is written to
   storage.local for the popup to read -- so the value must never reach it. */
function describe(rule: AnnotatedRule, err: unknown): string {
  const names = [
    ...(rule.action.requestHeaders ?? []).map((h) => h.header),
    ...(rule.action.responseHeaders ?? []).map((h) => h.header),
  ];
  const what = names.length ? names.join(', ') : rule.action.type;
  return `${rule.__profile ?? 'unknown profile'}: ${what} — ${reason(err)}`;
}

export interface ApplyOutcome {
  readonly result: CompileResult;
  readonly errors: readonly string[];
  readonly status: Status;
}

/* Compiles the current config and applies it. Serialised: concurrent calls
   coalesce into one follow-up run rather than racing. */
export async function applyRules(now: number = Date.now()): Promise<ApplyOutcome | undefined> {
  if (running) {
    queued = true;
    return undefined;
  }
  running = true;

  try {
    const config = await loadConfig();
    const secrets = await resolveSecrets(config.settings);
    const unlocked =
      config.settings.credentialStorage === 'vault' ? await isUnlocked() : true;

    const result = compile(config, {
      resolve: (id) => secrets[id],
      unlocked,
      resolvedIds: new Set(Object.keys(secrets)),
    });

    const errors = [
      ...(await applyBucket(result.dynamic, dnr.getDynamic, dnr.updateDynamic)),
      ...(await applyBucket(result.session, dnr.getSession, dnr.updateSession)),
    ];

    const budget = budgetFor(result);
    const status: Status = {
      ruleErrors: errors,
      blocked: result.blocked.map((b) => ({
        profileId: b.profileId,
        profileName: b.profileName,
        reasons: [...b.verdict.reasons],
      })),
      problems: [...result.problems],
      vaultUnlocked: unlocked,
      budget: {
        dynamic: budget.dynamic.total,
        session: budget.session.total,
        pressure: budget.pressure,
        breaches: [...budget.breaches],
      },
      updatedAt: now,
    };

    await saveStatus(status);
    await updateBadge(config, result, unlocked, secrets);

    return { result, errors, status };
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void applyRules();
    }
  }
}

/* Drops every session rule. In v1 the session set holds credential-bearing
   rules and nothing else, so this is exactly "forget the credentials the
   browser was given" -- which is what locking has to mean to be worth
   anything. */
export async function clearSessionRules(): Promise<number> {
  const existing = await dnr.getSession();
  if (existing.length === 0) return 0;
  await dnr.updateSession({ removeRuleIds: existing.map((r) => r.id) });
  return existing.length;
}

async function updateBadge(
  config: Config,
  result: CompileResult,
  unlocked: boolean,
  secrets: Record<string, string>,
): Promise<void> {
  if (config.paused) {
    await badge.set('off', '#6b7688', 'Headsmith — off');
    return;
  }

  const locked = config.settings.credentialStorage === 'vault' && !unlocked;
  if (locked) {
    await badge.set('lock', '#6d28d9', 'Headsmith — vault locked');
    return;
  }

  /* Counts header operations actually emitted, not operations configured. A
     badge that counted the latter would claim a credential rule is active
     while it was being withheld. */
  const count = [...result.dynamic, ...result.session].reduce(
    (total, rule) =>
      total +
      (rule.action.requestHeaders?.length ?? 0) +
      (rule.action.responseHeaders?.length ?? 0),
    0,
  );

  const active = config.profiles.find((p) => p.id === config.activeProfileId);
  const suffix = result.blocked.length ? `, ${result.blocked.length} needing attention` : '';

  await badge.set(
    count ? String(count) : '',
    active?.color ?? '#b4470e',
    count
      ? `Headsmith — ${count} header${count === 1 ? '' : 's'} active${suffix}`
      : 'Headsmith — nothing active',
  );

  void secrets;
}

/* Every secret id still referenced, for orphan pruning. */
export async function referencedSecretIds(): Promise<string[]> {
  return collectSecretIds(await loadConfig());
}

/* Test seam: the module-level serialisation flags survive between tests in the
   same file otherwise. */
export function resetApplyState(): void {
  running = false;
  queued = false;
}
