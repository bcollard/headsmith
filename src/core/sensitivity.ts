/* Which header values are credentials.
 *
 * Derived from OpenModHeader's chromium/security.js.
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * The name list, the pattern list and the add-only sensitivity rule are
 * upstream's. See NOTICE.md.
 *
 * Pure name matching, no storage and no crypto, so it can be called from
 * anywhere -- the editor uses it to decide whether to offer the secret field,
 * the policy layer uses it to decide whether a profile needs a host
 * restriction, and the compiler uses it to route a rule to the session bucket.
 * One definition, three consumers, no chance of them disagreeing.
 *
 * The flag on a header can only *add* sensitivity. A user can mark
 * `X-Correlation-Id` as a secret; a user cannot mark `Authorization` as not
 * one. Detection that could be switched off is not a safety property.
 */

import { APPENDABLE_REQUEST_HEADERS, type HeaderOp } from './schema';

/* Exact names. Add a lowercase entry to teach the extension a new one --
   nothing else in the codebase hardcodes a header name. */
export const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'x-goog-api-key',
]);

/* Vendor-specific variants the exact list cannot enumerate: `X-Acme-Api-Key`,
   `X-Tenant-Session-Token`, and so on. */
export const SENSITIVE_HEADER_PATTERNS: readonly RegExp[] = [
  /(^|-)api[-_]?key$/i,
  /(^|-)auth(orization)?[-_]?token$/i,
  /(^|-)access[-_]?token$/i,
  /(^|-)session[-_]?token$/i,
  /(^|-)refresh[-_]?token$/i,
  /(^|-)id[-_]?token$/i,
  /(^|-)bearer$/i,
  /(^|-)secret$/i,
  /(^|-)credentials?$/i,
  /(^|-)password$/i,
  /(^|-)signature$/i,
];

export function isSensitiveHeaderName(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  if (SENSITIVE_HEADER_NAMES.has(key)) return true;
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key));
}

export function isSensitive(header: Pick<HeaderOp, 'name' | 'sensitive'>): boolean {
  return header.sensitive || isSensitiveHeaderName(header.name);
}

/* A `remove` carries no value, so it cannot leak one -- removing
   `Authorization` is a perfectly ordinary thing to want and should not drag a
   profile into needing an unlocked vault. This is the distinction between
   "this header name is sensitive" and "this operation handles a credential". */
export function carriesCredential(header: HeaderOp): boolean {
  if (header.operation === 'remove') return false;
  return isSensitive(header);
}

export function sensitiveHeadersOf(profile: {
  requestHeaders: HeaderOp[];
  responseHeaders: HeaderOp[];
}): HeaderOp[] {
  return [...profile.requestHeaders, ...profile.responseHeaders].filter(carriesCredential);
}

export function hasSensitiveContent(profile: {
  requestHeaders: HeaderOp[];
  responseHeaders: HeaderOp[];
}): boolean {
  return sensitiveHeadersOf(profile).some((h) => h.enabled && h.name.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Operation validity
// ---------------------------------------------------------------------------

export type OperationProblem =
  | { kind: 'append-not-allowed'; header: string }
  | { kind: 'empty-name' }
  | { kind: 'invalid-name'; header: string };

/* Chrome validates header names and the append restriction when a rule is
   submitted, and rejects the *entire batch* on one bad rule. Catching it here
   means a typo costs the user an inline warning rather than every rule in the
   profile silently failing to apply.
   Field names per RFC 9110: one or more token characters. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function checkOperation(
  header: HeaderOp,
  target: 'request' | 'response',
): OperationProblem | null {
  const name = header.name.trim();
  if (!name) return { kind: 'empty-name' };
  if (!TOKEN.test(name)) return { kind: 'invalid-name', header: name };
  if (
    header.operation === 'append' &&
    target === 'request' &&
    !APPENDABLE_REQUEST_HEADERS.has(name.toLowerCase())
  ) {
    // Response headers have no such restriction; this is request-only.
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
