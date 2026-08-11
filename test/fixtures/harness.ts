/* Snapshot harness for compiled declarativeNetRequest rules.
 *
 * Derived from FlexHeader's src/background/__fixtures__/fixtureHelpers.ts.
 * Copyright (c) 2025 harrisondeo. MIT licensed.
 * https://github.com/harrisondeo/FlexHeader
 *
 * The snapshot-and-regenerate pattern, including the UPDATE_FIXTURES switch,
 * is upstream's. See NOTICE.md.
 *
 * The single best idea taken from FlexHeader. The question that matters when
 * touching a rule compiler is "did this change what the browser gets?", and it
 * is not answerable by reading a diff of the compiler -- a one-line change to
 * condition building can silently turn eight rules into ninety-six, or move a
 * credential from the session bucket to the dynamic one.
 *
 * So the compiled output is recorded as JSON and compared byte for byte. A
 * deliberate change shows up as a reviewable fixture diff; an accidental one
 * shows up as a failing test.
 *
 * Two differences from FlexHeader's version:
 *
 *   - Fixtures record which bucket each rule landed in. Whether a rule carries
 *     a credential into a session rule or a disk-persisted dynamic one is the
 *     single most security-relevant fact about the output, so it is pinned
 *     rather than left implicit.
 *   - Regenerating requires UPDATE_FIXTURES *and* leaves the assertion helpers
 *     running, so a fixture cannot be updated into a state that contradicts
 *     what the test says it is checking.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { forChrome, type CompileResult } from '../../src/core/compile';
import { budgetFor } from '../../src/core/budget';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'rules');

export function shouldUpdate(): boolean {
  return process.env['UPDATE_FIXTURES'] === 'true';
}

/* What gets recorded. Deliberately not the raw CompileResult: `__profile` is
   provenance for error messages and would make every fixture churn on a
   profile rename, while the bucket split is the thing worth pinning. */
export interface RuleSnapshot {
  readonly dynamic: unknown[];
  readonly session: unknown[];
  readonly blocked: { profileName: string; reasons: readonly string[] }[];
  readonly budget: { dynamic: unknown; session: unknown; overBudget: boolean };
}

export function snapshotOf(result: CompileResult): RuleSnapshot {
  const budget = budgetFor(result);
  return {
    dynamic: forChrome(result.dynamic),
    session: forChrome(result.session),
    blocked: result.blocked.map((b) => ({
      profileName: b.profileName,
      reasons: [...b.verdict.reasons],
    })),
    budget: {
      dynamic: budget.dynamic,
      session: budget.session,
      overBudget: budget.overBudget,
    },
  };
}

export function compareWithFixture(result: CompileResult, name: string): RuleSnapshot {
  const snapshot = snapshotOf(result);
  const path = join(FIXTURES_DIR, `${name}.json`);

  if (shouldUpdate()) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return snapshot;
  }

  if (!existsSync(path)) {
    throw new Error(
      `Fixture not found: ${path}\nRun \`npm run test:update-fixtures\` to create it, then review the diff.`,
    );
  }

  expect(snapshot).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  return snapshot;
}

// ---------------------------------------------------------------------------
// Assertions that survive a fixture regeneration
// ---------------------------------------------------------------------------

/* A fixture on its own only proves the output has not changed -- if the very
   first recording was wrong, it stays wrong forever. These say what the output
   is supposed to *be*, so regenerating a fixture cannot quietly enshrine a
   regression. */

type Bucket = 'dynamic' | 'session';

export function headerEntries(
  snapshot: RuleSnapshot,
  bucket: Bucket,
): { header: string; operation: string; value?: string }[] {
  const out: { header: string; operation: string; value?: string }[] = [];
  for (const rule of snapshot[bucket] as {
    action?: { requestHeaders?: unknown[]; responseHeaders?: unknown[] };
  }[]) {
    for (const entry of [
      ...(rule.action?.requestHeaders ?? []),
      ...(rule.action?.responseHeaders ?? []),
    ]) {
      out.push(entry as { header: string; operation: string; value?: string });
    }
  }
  return out;
}

/** Asserts a header value appears in one bucket and in no other. */
export function expectValueOnlyIn(snapshot: RuleSnapshot, value: string, bucket: Bucket): void {
  const other: Bucket = bucket === 'dynamic' ? 'session' : 'dynamic';
  const inBucket = JSON.stringify(snapshot[bucket]).includes(value);
  const inOther = JSON.stringify(snapshot[other]).includes(value);
  expect(inBucket, `expected "${value}" in the ${bucket} bucket`).toBe(true);
  expect(inOther, `"${value}" must not appear in the ${other} bucket`).toBe(false);
}

/** Asserts a value appears nowhere in the compiled output at all. */
export function expectValueAbsent(snapshot: RuleSnapshot, value: string): void {
  const serialised = JSON.stringify(snapshot);
  expect(serialised.includes(value), `"${value}" must not appear in any rule`).toBe(false);
}

export function ruleCount(snapshot: RuleSnapshot): number {
  return snapshot.dynamic.length + snapshot.session.length;
}
