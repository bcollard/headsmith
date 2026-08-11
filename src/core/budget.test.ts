import { describe, it, expect } from 'vitest';
import { budgetFor, measure, estimateProfileCost, LIMITS } from './budget';
import type { AnnotatedRule } from './compile';

function rules(
  count: number,
  patch: { action?: string; regex?: boolean } = {},
): AnnotatedRule[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: (patch.action ?? 'modifyHeaders') as 'modifyHeaders' | 'allow' },
    condition: patch.regex ? { regexFilter: `^https://a${i}\\.test/` } : { urlFilter: `/p${i}` },
  }));
}

describe('measure', () => {
  it('counts modifyHeaders as unsafe', () => {
    // The distinction the raised 30,000 dynamic-rule quota turns on: it
    // applies only to safe actions, and modifyHeaders is not one.
    expect(measure(rules(3))).toEqual({ total: 3, unsafe: 3, regex: 0 });
  });

  it('counts allow, block, allowAllRequests and upgradeScheme as safe', () => {
    for (const action of ['allow', 'block', 'allowAllRequests', 'upgradeScheme']) {
      expect(measure(rules(2, { action })).unsafe).toBe(0);
    }
  });

  it('counts regex conditions separately from rules', () => {
    expect(measure(rules(5, { regex: true }))).toEqual({ total: 5, unsafe: 5, regex: 5 });
  });

  it('measures an empty set as zero', () => {
    expect(measure([])).toEqual({ total: 0, unsafe: 0, regex: 0 });
  });
});

describe('budgetFor', () => {
  it('reports a healthy set as under budget', () => {
    const report = budgetFor({ dynamic: rules(50), session: rules(10) });
    expect(report.overBudget).toBe(false);
    expect(report.breaches).toEqual([]);
  });

  it('flags too many unsafe dynamic rules', () => {
    const report = budgetFor({ dynamic: rules(LIMITS.unsafeDynamic + 1), session: [] });
    expect(report.overBudget).toBe(true);
    expect(report.breaches.join()).toMatch(/unsafe dynamic rules/);
  });

  it('flags too many unsafe session rules', () => {
    const report = budgetFor({ dynamic: [], session: rules(LIMITS.unsafeSession + 1) });
    expect(report.breaches.join()).toMatch(/unsafe session rules/);
  });

  it('flags too many regex rules in either set', () => {
    const overRegex = rules(LIMITS.regexPerRuleSet + 1, { regex: true });
    expect(budgetFor({ dynamic: overRegex, session: [] }).breaches.join()).toMatch(
      /regex dynamic rules/,
    );
    expect(budgetFor({ dynamic: [], session: overRegex }).breaches.join()).toMatch(
      /regex session rules/,
    );
  });

  it('flags the session total separately from the unsafe count', () => {
    // Session has a total ceiling as well as an unsafe one, so a set made
    // entirely of safe rules can still exceed it.
    const safe = rules(LIMITS.sessionTotal + 1, { action: 'allow' });
    const report = budgetFor({ dynamic: [], session: safe });
    expect(report.breaches.join()).toMatch(/session rules exceeds/);
    expect(report.breaches.join()).not.toMatch(/unsafe session/);
  });

  it('reports every ceiling breached, not just the first', () => {
    const report = budgetFor({
      dynamic: rules(LIMITS.unsafeDynamic + 1, { regex: true }),
      session: rules(LIMITS.unsafeSession + 1),
    });
    expect(report.breaches.length).toBeGreaterThanOrEqual(3);
  });

  describe('pressure', () => {
    it('tracks the tightest ceiling, not the rule count', () => {
      // 500 regex rules is half the regex budget but a tenth of the rule
      // budget. A meter that showed 10% would be lying about how close this
      // config is to failing.
      const report = budgetFor({ dynamic: rules(500, { regex: true }), session: [] });
      expect(report.pressure).toBeCloseTo(0.5, 5);
    });

    it('is zero for an empty config', () => {
      expect(budgetFor({ dynamic: [], session: [] }).pressure).toBe(0);
    });

    it('exceeds one when over budget', () => {
      expect(budgetFor({ dynamic: rules(LIMITS.unsafeDynamic + 1), session: [] }).pressure).toBeGreaterThan(1);
    });
  });
});

describe('estimateProfileCost', () => {
  it('costs one rule for a profile with no url filters', () => {
    expect(estimateProfileCost({ include: { urlContains: [], urlRegex: [] } })).toEqual({
      rules: 1,
      regexRules: 0,
    });
  });

  it('costs one rule per url term', () => {
    expect(
      estimateProfileCost({ include: { urlContains: ['/a', '/b'], urlRegex: ['^x'] } }),
    ).toEqual({ rules: 3, regexRules: 1 });
  });

  it('reports regex cost separately so the editor can warn about the scarcer budget', () => {
    const cost = estimateProfileCost({
      include: { urlContains: [], urlRegex: ['^a', '^b', '^c'] },
    });
    expect(cost.rules).toBe(3);
    expect(cost.regexRules).toBe(3);
  });
});
