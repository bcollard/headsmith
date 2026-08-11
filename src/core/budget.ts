/* Rule-budget accounting.
 *
 * declarativeNetRequest has two ceilings that matter here, and the interesting
 * one is not the one people quote.
 *
 * **Unsafe rules: 5,000 per rule set.** Chrome 121 raised
 * `MAX_NUMBER_OF_DYNAMIC_RULES` to 30,000, and that number gets repeated a
 * lot -- but it applies only to *safe* rules, meaning `block`, `allow`,
 * `allowAllRequests` and `upgradeScheme`. `modifyHeaders` is unsafe. So for a
 * header extension the binding limit is `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES`,
 * which is 5,000, and the 30,000 figure is worth nothing.
 *
 * **Regex rules: 1,000 per rule set.** Five times scarcer, counted separately
 * for dynamic, session and static. Neither reference project accounts for
 * this, and FlexHeader actively burns the budget: its catch-all for a header
 * with no include filter is `regexFilter: "|http*"`, so every unfiltered
 * header consumes one of the 1,000 slots to express "match everything" --
 * which an empty condition expresses for free.
 *
 * These functions are pure so the compiler's output can be checked against
 * them in a unit test, and so the editor can warn before the user gets there.
 */

import type { AnnotatedRule, CompileResult } from './compile';

/* Chrome's constants. Mirrored here rather than read from
   `chrome.declarativeNetRequest` because src/core must stay browser-free --
   and because a test needs to assert against a known number, not whichever
   Chrome happens to be running. */
export const LIMITS = {
  unsafeDynamic: 5000,
  unsafeSession: 5000,
  sessionTotal: 5000,
  regexPerRuleSet: 1000,
} as const;

/** Action types Chrome considers safe, and so exempt from the 5,000 ceiling. */
const SAFE_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);

export interface RuleSetUsage {
  readonly total: number;
  readonly unsafe: number;
  readonly regex: number;
}

export interface BudgetReport {
  readonly dynamic: RuleSetUsage;
  readonly session: RuleSetUsage;
  /** True when any ceiling is exceeded. */
  readonly overBudget: boolean;
  /** Human-readable descriptions of each ceiling breached. */
  readonly breaches: readonly string[];
  /** Fraction of the tightest relevant ceiling used, 0..1+. For a UI meter. */
  readonly pressure: number;
}

export function measure(rules: readonly AnnotatedRule[]): RuleSetUsage {
  let unsafe = 0;
  let regex = 0;
  for (const rule of rules) {
    if (!SAFE_ACTIONS.has(rule.action.type)) unsafe++;
    if (typeof rule.condition['regexFilter'] === 'string') regex++;
  }
  return { total: rules.length, unsafe, regex };
}

export function budgetFor(result: Pick<CompileResult, 'dynamic' | 'session'>): BudgetReport {
  const dynamic = measure(result.dynamic);
  const session = measure(result.session);
  const breaches: string[] = [];

  if (dynamic.unsafe > LIMITS.unsafeDynamic) {
    breaches.push(
      `${dynamic.unsafe} unsafe dynamic rules exceeds the limit of ${LIMITS.unsafeDynamic}`,
    );
  }
  if (dynamic.regex > LIMITS.regexPerRuleSet) {
    breaches.push(
      `${dynamic.regex} regex dynamic rules exceeds the limit of ${LIMITS.regexPerRuleSet}`,
    );
  }
  if (session.unsafe > LIMITS.unsafeSession) {
    breaches.push(
      `${session.unsafe} unsafe session rules exceeds the limit of ${LIMITS.unsafeSession}`,
    );
  }
  if (session.total > LIMITS.sessionTotal) {
    breaches.push(`${session.total} session rules exceeds the limit of ${LIMITS.sessionTotal}`);
  }
  if (session.regex > LIMITS.regexPerRuleSet) {
    breaches.push(
      `${session.regex} regex session rules exceeds the limit of ${LIMITS.regexPerRuleSet}`,
    );
  }

  /* The meter tracks whichever ceiling is closest to being hit, so a config
     that is fine on rule count but nearly out of regex slots still reads as
     nearly full. */
  const pressure = Math.max(
    dynamic.unsafe / LIMITS.unsafeDynamic,
    dynamic.regex / LIMITS.regexPerRuleSet,
    session.unsafe / LIMITS.unsafeSession,
    session.regex / LIMITS.regexPerRuleSet,
  );

  return { dynamic, session, overBudget: breaches.length > 0, breaches, pressure };
}

/* How many rules one profile will cost, without compiling the whole config.
   Lets the editor say "this profile costs 8 rules" as filters are added. */
export function estimateProfileCost(match: {
  include: { urlContains: string[]; urlRegex: string[] };
}): { rules: number; regexRules: number } {
  const conditions = match.include.urlContains.length + match.include.urlRegex.length;
  return {
    // At least one condition, and at most two rules per condition -- one for
    // the plain half and one for the credential half.
    rules: Math.max(conditions, 1),
    regexRules: match.include.urlRegex.length,
  };
}
