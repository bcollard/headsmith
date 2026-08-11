/* Handing compiled rules to the browser.
 *
 * Recovering from a batch the engine rejects, and naming the offender by header
 * only, are ideas from OpenModHeader (MIT, (c) 2026 Shiva M). The recovery
 * strategy here differs -- see below, and NOTICE.md.
 *
 * The compiler decides what the rules are. This decides how they get there,
 * and has three problems to solve that the compiler does not.
 *
 * ## 1. Replacement has to be atomic
 *
 * Each update removes every existing rule in the set and adds the new ones in
 * the same call, so there is no instant at which a request could be matched by
 * a half-applied rule set.
 *
 * ## 2. One bad rule must not take the others down
 *
 * declarativeNetRequest validates a batch as a unit and rejects *all* of it if
 * any single rule is malformed. Left alone, one bad regex silently disables
 * everything the user has configured.
 *
 * The obvious recovery is to re-add the rules one at a time. That works, and
 * it costs one engine round-trip per rule -- 120 calls for a config with 120
 * rules, every time, for one typo. Instead this bisects: split the batch, try
 * each half, and recurse only into halves that fail. A single bad rule among
 * 120 is found in about 14 calls rather than 120, and a batch that fails for a
 * reason unrelated to any individual rule (a quota, say) is discovered almost
 * immediately rather than after re-testing everything.
 *
 * ## 3. Builds must not race
 *
 * Storage changes, alarms and startup can all fire at once. Overlapping
 * updates would interleave their remove-then-add pairs, so a build in flight
 * sets a flag and the next request coalesces into a single follow-up run.
 */

import { budgetFor } from '../core/budget';
import { compile, forChrome, type AnnotatedRule, type CompileResult } from '../core/compile';
import { collectSecretIds, type Config } from '../core/schema';
import { badge, dnr, type RuleUpdate } from '../platform/chrome';
import { resolveSecrets, isUnlocked } from './secrets';
import { loadConfig, saveStatus, type Status } from './store';

type Engine = {
  read: () => Promise<{ id: number }[]>;
  write: (update: RuleUpdate) => Promise<void>;
};

let running = false;
let queued = false;

/* Adds `rules`, returning the ones the engine refused.
 *
 * Bisection: if a batch is rejected and holds more than one rule, split it and
 * recurse. A single rule that is rejected alone is the culprit and is
 * reported. Rules already accepted stay accepted -- adds are cumulative once
 * the set has been cleared. */
async function addRules(engine: Engine, rules: readonly AnnotatedRule[]): Promise<AnnotatedRule[]> {
  if (rules.length === 0) return [];

  try {
    await engine.write({ addRules: forChrome(rules) as chrome.declarativeNetRequest.Rule[] });
    return [];
  } catch (err) {
    if (rules.length === 1) {
      lastError.set(rules[0]!, err);
      return [...rules];
    }
  }

  const middle = Math.floor(rules.length / 2);
  return [
    ...(await addRules(engine, rules.slice(0, middle))),
    ...(await addRules(engine, rules.slice(middle))),
  ];
}

/* Why each rejected rule was rejected, populated during bisection. A WeakMap
   so it cannot keep rules alive past the build that produced them. */
const lastError = new WeakMap<AnnotatedRule, unknown>();

async function applyBucket(engine: Engine, rules: readonly AnnotatedRule[]): Promise<string[]> {
  const errors: string[] = [];

  /* Every engine call is treated as fallible, including the ones that
     "cannot" fail. applyRules is the top of the stack: an uncaught throw below
     means no rules are applied *and* no status is written, leaving a silently
     dead extension with nothing to explain it. Quota exhaustion can make even
     a remove-only call fail. */
  let existing: { id: number }[] = [];
  try {
    existing = await engine.read();
  } catch (err) {
    errors.push(`could not read the existing rules — ${reason(err)}`);
  }

  const removeRuleIds = existing.map((rule) => rule.id);

  // The happy path: one call that both clears and replaces, atomically.
  try {
    await engine.write({
      removeRuleIds,
      addRules: forChrome(rules) as chrome.declarativeNetRequest.Rule[],
    });
    return errors;
  } catch {
    /* Rejected as a batch. Clear the set, then find the offenders. */
  }

  try {
    await engine.write({ removeRuleIds });
  } catch (err) {
    /* The set could not be cleared, so stale rules may still be live. Say so
       rather than adding on top of a state we cannot describe. */
    errors.push(`could not clear the previous rules — ${reason(err)}`);
    return errors;
  }

  for (const rejected of await addRules(engine, rules)) {
    errors.push(describe(rejected, lastError.get(rejected)));
  }
  return errors;
}

/* Describes a rejected rule by header *name* only.
 *
 * A rule that failed may carry a credential in its value, and this string is
 * written to storage.local for the popup to read. The value must never reach
 * it. */
function describe(rule: AnnotatedRule, err: unknown): string {
  const names = [
    ...(rule.action.requestHeaders ?? []).map((h) => h.header),
    ...(rule.action.responseHeaders ?? []).map((h) => h.header),
  ];
  const what = names.length > 0 ? names.join(', ') : rule.action.type;
  return `${rule.__profile ?? 'unknown profile'}: ${what} — ${reason(err)}`;
}

function reason(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, '');
}

export interface ApplyOutcome {
  readonly result: CompileResult;
  readonly errors: readonly string[];
  readonly status: Status;
}

/* Compiles the current config and applies it. Serialised: a concurrent call
   coalesces into one follow-up run rather than racing. */
export async function applyRules(now: number = Date.now()): Promise<ApplyOutcome | undefined> {
  if (running) {
    queued = true;
    return undefined;
  }
  running = true;

  try {
    const config = await loadConfig();
    const secrets = await resolveSecrets(config.settings);
    const unlocked = config.settings.credentialStorage === 'vault' ? await isUnlocked() : true;

    const result = compile(config, {
      resolve: (id) => secrets[id],
      unlocked,
      resolvedIds: new Set(Object.keys(secrets)),
    });

    const errors = [
      ...(await applyBucket({ read: dnr.getDynamic, write: dnr.updateDynamic }, result.dynamic)),
      ...(await applyBucket({ read: dnr.getSession, write: dnr.updateSession }, result.session)),
    ];

    const budget = budgetFor(result);
    const status: Status = {
      ruleErrors: errors,
      blocked: result.blocked.map((entry) => ({
        profileId: entry.profileId,
        profileName: entry.profileName,
        reasons: [...entry.verdict.reasons],
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
    await updateBadge(config, result, unlocked);

    return { result, errors, status };
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void applyRules();
    }
  }
}

/* Drops every session rule.
 *
 * In v1 the session set holds credential-bearing rules and nothing else, so
 * this is exactly "forget the credentials the browser was handed" -- which is
 * what locking has to mean. Discarding the key alone would not stop the
 * browser from continuing to send a rule it already has. */
export async function clearSessionRules(): Promise<number> {
  const existing = await dnr.getSession();
  if (existing.length === 0) return 0;
  await dnr.updateSession({ removeRuleIds: existing.map((rule) => rule.id) });
  return existing.length;
}

async function updateBadge(
  config: Config,
  result: CompileResult,
  unlocked: boolean,
): Promise<void> {
  if (config.paused) {
    await badge.set('off', '#6b7688', 'Headsmith — off');
    return;
  }

  if (config.settings.credentialStorage === 'vault' && !unlocked) {
    await badge.set('lock', '#6d28d9', 'Headsmith — vault locked');
    return;
  }

  /* Counts header operations actually emitted, not operations configured. The
     difference matters: a badge counting configuration would claim a
     credential rule is active while it was being withheld. */
  const count = [...result.dynamic, ...result.session].reduce(
    (total, rule) =>
      total + (rule.action.requestHeaders?.length ?? 0) + (rule.action.responseHeaders?.length ?? 0),
    0,
  );

  const active = config.profiles.find((profile) => profile.id === config.activeProfileId);
  const attention = result.blocked.length > 0 ? `, ${result.blocked.length} needing attention` : '';

  await badge.set(
    count > 0 ? String(count) : '',
    active?.color ?? '#b4470e',
    count > 0
      ? `Headsmith — ${count} header${count === 1 ? '' : 's'} active${attention}`
      : 'Headsmith — nothing active',
  );
}

/** Every secret id still referenced, for orphan pruning. */
export async function referencedSecretIds(): Promise<string[]> {
  return collectSecretIds(await loadConfig());
}

/* Test seam: the module-level serialisation flags otherwise persist between
   tests in the same file. */
export function resetApplyState(): void {
  running = false;
  queued = false;
}
