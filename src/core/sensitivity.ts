/* Which header values are credentials, and why.
 *
 * The rule that a user may add sensitivity but never remove it comes from
 * OpenModHeader (MIT, (c) 2026 Shiva M). See NOTICE.md.
 *
 * Pure name analysis. No storage, no crypto, no browser APIs, so the editor,
 * the policy gate and the compiler can all ask the same question and cannot
 * disagree about the answer.
 *
 * Detection is a small ordered table of rules rather than a name list plus a
 * pile of regular expressions, for one reason: **a match carries a reason.**
 * A lock icon that appears without explanation looks like a bug to anyone who
 * did not expect it, and the first thing they will try is turning it off. A
 * rule that can say "this ends in -token, so it is treated as a credential"
 * gets understood instead of fought.
 *
 * The user's flag can only ever *add* sensitivity. Someone may mark
 * `X-Tenant-Ref` as a credential; nobody may mark `Authorization` as not one.
 * Detection that can be switched off is not a safety property.
 */

import { APPENDABLE_REQUEST_HEADERS, type HeaderOp } from './schema';

export type SensitivityReason =
  | 'http-authentication'
  | 'cookie'
  | 'api-key'
  | 'token'
  | 'secret-material'
  | 'marked-by-user';

/* Ordered. The first match wins, so the specific standard headers come before
   the shape-based conventions -- `Proxy-Authorization` should be reported as
   HTTP authentication, not as something that happens to end in a word.

   The shape rules are anchored to a word boundary at the end of the name
   because that is where the meaning lives: `X-Acme-Api-Key` is a key,
   `X-Keyboard-Layout` is not, and only the anchor tells them apart. */
interface Rule {
  readonly reason: SensitivityReason;
  readonly test: (name: string) => boolean;
  readonly explain: string;
}

const exactly = (...names: string[]) => {
  const set = new Set(names);
  return (name: string) => set.has(name);
};

const endsWith = (pattern: RegExp) => (name: string) => pattern.test(name);

const RULES: readonly Rule[] = [
  {
    reason: 'http-authentication',
    // The headers RFC 9110 defines for carrying authentication.
    test: exactly('authorization', 'proxy-authorization'),
    explain: 'carries HTTP authentication credentials',
  },
  {
    reason: 'cookie',
    /* A cookie header is a bearer credential in almost every real deployment,
       even when an individual cookie in it is not. It cannot be split, so the
       whole header is treated as sensitive. */
    test: exactly('cookie', 'set-cookie'),
    explain: 'carries session cookies',
  },
  {
    reason: 'api-key',
    test: endsWith(/(^|[-_])api[-_]?key$/),
    explain: 'names an API key',
  },
  {
    reason: 'token',
    test: endsWith(/(^|[-_])(token|jwt|bearer)$/),
    explain: 'names a token',
  },
  {
    reason: 'secret-material',
    test: endsWith(/(^|[-_])(secret|password|passwd|credentials?|signature|sig)$/),
    explain: 'names secret material',
  },
];

export function normaliseHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

/* The reason a header name is treated as a credential, or null. Exported so
   the editor can explain itself rather than only decorate. */
export function sensitivityOf(name: string): { reason: SensitivityReason; explain: string } | null {
  const key = normaliseHeaderName(name);
  if (!key) return null;
  for (const rule of RULES) {
    if (rule.test(key)) return { reason: rule.reason, explain: rule.explain };
  }
  return null;
}

export function isSensitiveHeaderName(name: string): boolean {
  return sensitivityOf(name) !== null;
}

export function isSensitive(header: Pick<HeaderOp, 'name' | 'sensitive'>): boolean {
  return header.sensitive || isSensitiveHeaderName(header.name);
}

export function explainSensitivity(header: Pick<HeaderOp, 'name' | 'sensitive'>): string | null {
  const detected = sensitivityOf(header.name);
  if (detected) return `Treated as a credential because the name ${detected.explain}.`;
  if (header.sensitive) return 'Treated as a credential because you marked it as one.';
  return null;
}

/* Whether an operation actually handles a credential value.
 *
 * Distinct from "is this header name sensitive", and the distinction matters:
 * removing `Authorization` involves no secret at all. Treating it as
 * credential-bearing would demand an unlocked vault and a host restriction to
 * do something that only ever *deletes* a value. */
export function carriesCredential(header: HeaderOp): boolean {
  return header.operation !== 'remove' && isSensitive(header);
}

type HeaderLists = { requestHeaders: HeaderOp[]; responseHeaders: HeaderOp[] };

export function sensitiveHeadersOf(profile: HeaderLists): HeaderOp[] {
  return [...profile.requestHeaders, ...profile.responseHeaders].filter(carriesCredential);
}

export function hasSensitiveContent(profile: HeaderLists): boolean {
  return sensitiveHeadersOf(profile).some((h) => h.enabled && h.name.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Whether Chrome will accept the operation at all
// ---------------------------------------------------------------------------

export type OperationProblem =
  | { kind: 'empty-name' }
  | { kind: 'invalid-name'; header: string }
  | { kind: 'append-not-allowed'; header: string };

/* RFC 9110 field names are one or more token characters. Chrome validates
   this when the rule is submitted and rejects the *whole batch* on failure,
   so a typo caught here costs an inline warning instead of every other rule
   in the profile silently ceasing to apply. */
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function checkOperation(
  header: HeaderOp,
  target: 'request' | 'response',
): OperationProblem | null {
  const name = header.name.trim();
  if (!name) return { kind: 'empty-name' };
  if (!FIELD_NAME.test(name)) return { kind: 'invalid-name', header: name };

  /* Chrome permits `append` on only a fixed set of request headers -- the ones
     whose grammar is a comma-separated list, where appending is meaningful.
     Response headers have no such restriction. */
  if (
    header.operation === 'append' &&
    target === 'request' &&
    !APPENDABLE_REQUEST_HEADERS.has(name.toLowerCase())
  ) {
    return { kind: 'append-not-allowed', header: name };
  }

  return null;
}

export function describeProblem(problem: OperationProblem): string {
  switch (problem.kind) {
    case 'empty-name':
      return 'This header has no name.';
    case 'invalid-name':
      return `"${problem.header}" is not a valid header name.`;
    case 'append-not-allowed':
      return `Chrome does not allow appending to "${problem.header}". Use Set instead, or pick one of the appendable request headers.`;
  }
}
