/* An in-memory stand-in for the parts of chrome.* Headsmith touches.
 *
 * Hand-rolled rather than pulled from a package, for one specific reason: the
 * plaintext-secret guard works by writing a sensitive header and then dumping
 * the entire contents of the fake `storage.local` to assert the cleartext
 * appears nowhere in it. That test is only worth anything if the fake's
 * storage really is a plain observable object with no serialisation quirks of
 * its own -- so the storage is exactly a Map of structured-cloned values, and
 * `dumpLocal()` returns precisely what a real storage area would hold.
 *
 * The declarativeNetRequest fake also enforces the parts of Chrome's rule
 * validation that matter to us -- unique ids, the unsafe-rule ceiling, the
 * regex ceiling, tabIds being session-only -- so a unit test can catch a rule
 * Chrome would reject without waiting for the e2e suite.
 */

import { vi } from 'vitest';

/* Chrome's real ceilings, as of the current documentation. `modifyHeaders`
   and `redirect` are *unsafe* actions, so the raised 30,000 dynamic-rule quota
   -- which applies only to block/allow/allowAllRequests/upgradeScheme -- is
   irrelevant to Headsmith. These are the numbers that actually bind. */
export const LIMITS = {
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_SESSION_RULES: 5000,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
  /** Counted separately for each of dynamic, session and static. */
  MAX_NUMBER_OF_REGEX_RULES: 1000,
} as const;

const SAFE_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);

export interface FakeRule {
  id: number;
  priority?: number;
  action: { type: string; [k: string]: unknown };
  condition: Record<string, unknown>;
}

interface UpdateOptions {
  removeRuleIds?: number[];
  addRules?: FakeRule[];
}

class FakeStorageArea {
  private store = new Map<string, unknown>();

  get = vi.fn(async (keys?: string | string[] | null) => {
    const out: Record<string, unknown> = {};
    if (keys == null) {
      for (const [k, v] of this.store) out[k] = clone(v);
      return out;
    }
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.store.has(key)) out[key] = clone(this.store.get(key));
    }
    return out;
  });

  set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) this.store.set(k, clone(v));
  });

  remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.store.delete(key);
  });

  clear = vi.fn(async () => {
    this.store.clear();
  });

  /** Everything held, for assertions. Not part of the chrome API. */
  dump(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.store) out[k] = clone(v);
    return out;
  }

  /** Every value serialised, for "does this string appear anywhere" checks. */
  dumpJson(): string {
    return JSON.stringify(this.dump());
  }

  get size(): number {
    return this.store.size;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

class FakeRuleSet {
  private rules = new Map<number, FakeRule>();

  constructor(
    private readonly kind: 'dynamic' | 'session',
    private readonly limits = LIMITS,
  ) {}

  get = vi.fn(async (): Promise<FakeRule[]> => [...this.rules.values()].map(clone));

  update = vi.fn(async (options: UpdateOptions) => {
    // Chrome removes before it adds, which is what makes a
    // remove-everything-then-add-everything update atomic.
    const next = new Map(this.rules);
    for (const id of options.removeRuleIds ?? []) next.delete(id);

    for (const rule of options.addRules ?? []) {
      this.validate(rule, next);
      next.set(rule.id, clone(rule));
    }

    this.checkCeilings(next);
    this.rules = next;
  });

  private validate(rule: FakeRule, pending: Map<number, FakeRule>): void {
    if (!Number.isInteger(rule.id) || rule.id < 1) {
      throw new Error(`Invalid rule id: ${rule.id}`);
    }
    if (pending.has(rule.id)) {
      throw new Error(`Rule with id ${rule.id} already exists`);
    }
    if (!rule.action?.type) {
      throw new Error(`Rule ${rule.id} has no action type`);
    }
    /* The constraint that shapes Headsmith's dynamic/session split: a
       tab-scoped condition is only legal on a session rule. */
    if (this.kind === 'dynamic') {
      if ('tabIds' in rule.condition || 'excludedTabIds' in rule.condition) {
        throw new Error(
          `Rule ${rule.id}: tabIds is only supported for session-scoped rules`,
        );
      }
    }
    if (rule.action.type === 'modifyHeaders') {
      const req = (rule.action['requestHeaders'] ?? []) as { header?: string }[];
      const res = (rule.action['responseHeaders'] ?? []) as { header?: string }[];
      if (req.length === 0 && res.length === 0) {
        throw new Error(`Rule ${rule.id}: modifyHeaders with no headers`);
      }
      for (const h of [...req, ...res]) {
        if (!h.header) throw new Error(`Rule ${rule.id}: header entry with no name`);
        if (h.header !== h.header.toLowerCase()) {
          throw new Error(`Rule ${rule.id}: header name must be lowercase (${h.header})`);
        }
      }
    }
    const regex = rule.condition['regexFilter'];
    if (typeof regex === 'string') {
      try {
        new RegExp(regex);
      } catch {
        throw new Error(`Rule ${rule.id}: regexFilter is not a valid expression`);
      }
      /* RE2 has no lookaround. Chrome rejects such a filter, and it is an easy
         mistake to make when trying to express "everything except". */
      if (/\(\?[=!<]/.test(regex)) {
        throw new Error(`Rule ${rule.id}: regexFilter uses lookaround, which RE2 does not support`);
      }
    }
  }

  private checkCeilings(next: Map<number, FakeRule>): void {
    const all = [...next.values()];
    const unsafe = all.filter((r) => !SAFE_ACTIONS.has(r.action.type)).length;
    const regexes = all.filter((r) => typeof r.condition['regexFilter'] === 'string').length;

    const unsafeMax =
      this.kind === 'dynamic'
        ? this.limits.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES
        : this.limits.MAX_NUMBER_OF_UNSAFE_SESSION_RULES;

    if (unsafe > unsafeMax) {
      throw new Error(`Too many unsafe ${this.kind} rules: ${unsafe} > ${unsafeMax}`);
    }
    if (this.kind === 'session' && all.length > this.limits.MAX_NUMBER_OF_SESSION_RULES) {
      throw new Error(
        `Too many session rules: ${all.length} > ${this.limits.MAX_NUMBER_OF_SESSION_RULES}`,
      );
    }
    if (regexes > this.limits.MAX_NUMBER_OF_REGEX_RULES) {
      throw new Error(
        `Too many regex ${this.kind} rules: ${regexes} > ${this.limits.MAX_NUMBER_OF_REGEX_RULES}`,
      );
    }
  }

  /** For assertions. Not part of the chrome API. */
  snapshot(): FakeRule[] {
    return [...this.rules.values()].map(clone).sort((a, b) => a.id - b.id);
  }
}

export function createFakeChrome() {
  const local = new FakeStorageArea();
  const session = new FakeStorageArea();
  const dynamicRules = new FakeRuleSet('dynamic');
  const sessionRules = new FakeRuleSet('session');

  const alarmListeners: ((alarm: { name: string }) => void)[] = [];
  const alarms = new Map<string, { name: string; when: number }>();

  const fake = {
    storage: {
      local,
      session: Object.assign(session, {
        /* Present so a test can assert it is never called: widening the access
           level would expose the derived vault key to content scripts. */
        setAccessLevel: vi.fn(async () => {
          throw new Error('Headsmith must never widen storage.session access level');
        }),
      }),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },

    declarativeNetRequest: {
      ...LIMITS,
      getDynamicRules: dynamicRules.get,
      updateDynamicRules: dynamicRules.update,
      getSessionRules: sessionRules.get,
      updateSessionRules: sessionRules.update,
    },

    alarms: {
      create: vi.fn((name: string, info: { when: number }) => {
        alarms.set(name, { name, when: info.when });
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: {
        addListener: vi.fn((fn: (alarm: { name: string }) => void) => {
          alarmListeners.push(fn);
        }),
      },
    },

    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setBadgeTextColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },

    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      lastError: undefined as { message: string } | undefined,
    },
  };

  return {
    chrome: fake,

    /* Test-only helpers, kept off the `chrome` object so nothing under test
       can reach them by accident. */
    dumpLocal: () => local.dump(),
    dumpLocalJson: () => local.dumpJson(),
    dumpSession: () => session.dump(),
    dumpSessionJson: () => session.dumpJson(),
    dynamicSnapshot: () => dynamicRules.snapshot(),
    sessionSnapshot: () => sessionRules.snapshot(),
    fireAlarm: (name: string) => {
      for (const listener of alarmListeners) listener({ name });
    },
    pendingAlarms: () => [...alarms.values()],
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;

/* Installs the fake as the global `chrome`, returning the handle. */
export function installFakeChrome(): FakeChrome {
  const handle = createFakeChrome();
  (globalThis as unknown as { chrome: unknown }).chrome = handle.chrome;
  return handle;
}
