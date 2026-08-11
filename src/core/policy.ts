/* The single decision point for whether a profile's credential-bearing rules
 * may be applied.
 *
 * Derived from OpenModHeader's chromium/security.js.
 * Copyright (c) 2026 Shiva M. MIT licensed.
 * https://github.com/Multivalence/OpenModHeader
 *
 * The activation-gate concept, the verdict shape, the wildcard-rejection
 * pattern and the loopback exemption list are upstream's. See NOTICE.md.
 *
 * Everything here is decidable from a profile plus settings plus the set of
 * secret ids that actually resolved. No storage, no crypto, no clock. That is
 * what makes "would this profile release a credential?" a question a test can
 * ask about a plain object.
 *
 * The output separates two things that are easy to conflate:
 *
 *   - `blocked` means the credential-bearing half of this profile must not be
 *     emitted. Its ordinary headers still apply.
 *   - `warnings` are things worth telling the user that do not stop anything.
 */

import { hasSensitiveContent, sensitiveHeadersOf } from './sensitivity';
import type { MatchSet, Profile, Settings } from './schema';

export type BlockReason = 'no-host-restriction' | 'vault-locked' | 'missing-credential';

export type Warning =
  | { kind: 'insecure-host'; hosts: string[] }
  | { kind: 'broad-match'; detail: string };

export interface Verdict {
  /** Whether this profile handles a credential at all. */
  readonly hasSensitive: boolean;
  /** Whether the credential-bearing rules must be withheld. */
  readonly blocked: boolean;
  readonly reasons: readonly BlockReason[];
  readonly warnings: readonly Warning[];
  /** Secret ids referenced but not resolvable. */
  readonly missingSecretIds: readonly string[];
  /** Sensitive headers with no secretId at all -- hand-edited or half-imported. */
  readonly unmanagedHeaders: readonly string[];
}

/* A match set counts as a host restriction only if it actually narrows
   traffic. This is the check that stops the "add a host filter" requirement
   being satisfied by typing a star. */
export function isHostRestricted(match: MatchSet): boolean {
  if (match.include.domains.length > 0) return true;

  /* A url-contains value has to contain something host-like. A bare `/` or
     `http` narrows nothing worth counting. */
  if (match.include.urlContains.some((v) => meaningfulUrlFragment(v))) return true;

  /* A regex of nothing but wildcards and anchors restricts nothing. */
  if (match.include.urlRegex.some((v) => meaningfulRegex(v))) return true;

  return false;
}

const WILDCARD_ONLY = /^(\*|\*:\/\/\*\/\*|<all_urls>|https?:\/\/\*?\/?\*?|\/|\.\*|\^?\.\*\$?)$/i;

function meaningfulUrlFragment(value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  if (WILDCARD_ONLY.test(v)) return false;
  // Needs at least one alphanumeric run that is not just a scheme.
  return /[a-z0-9]/i.test(v.replace(/^https?:\/\//i, ''));
}

function meaningfulRegex(value: string): boolean {
  const v = value.trim();
  if (!v || WILDCARD_ONLY.test(v)) return false;
  // Strip escapes and metacharacters; something literal must remain.
  const literal = v.replace(/\\[a-z]/gi, '').replace(/[.*+?^${}()|[\]\\/]/g, '');
  return /[a-z0-9]/i.test(literal);
}

/* Best-effort scheme check. `http://dev.internal` in a filter is plainly
   insecure; a bare `api.example.com` is scheme-agnostic and does not warrant
   a warning that would train the user to ignore warnings. Loopback and .local
   are exempt because that is where plaintext http is normal and fine. */
export function insecureHosts(match: MatchSet): string[] {
  const candidates = [...match.include.urlContains, ...match.include.urlRegex];
  return candidates
    .filter((v) => /(^|[^s])http:\/\//i.test(v))
    .filter((v) => !/(localhost|127\.0\.0\.1|\[::1\]|\.local\b|\.test\b|\.localhost\b)/i.test(v))
    .map((v) => v.trim());
}

export interface EvaluateContext {
  /** False when the vault exists but is locked. Always true in session mode. */
  readonly unlocked?: boolean;
  /** Ids that resolved to an actual value. Omit to skip the resolution check. */
  readonly resolvedIds?: ReadonlySet<string> | undefined;
}

export function evaluateProfile(
  profile: Profile,
  settings: Settings,
  context: EvaluateContext = {},
): Verdict {
  const { unlocked = true, resolvedIds } = context;

  const sensitive = sensitiveHeadersOf(profile).filter((h) => h.enabled && h.name.trim());
  const hasSensitive = hasSensitiveContent(profile);

  const reasons: BlockReason[] = [];
  const warnings: Warning[] = [];
  let missingSecretIds: string[] = [];
  let unmanagedHeaders: string[] = [];

  if (!hasSensitive) {
    return {
      hasSensitive: false,
      blocked: false,
      reasons,
      warnings,
      missingSecretIds,
      unmanagedHeaders,
    };
  }

  /* A credential attached to every request the browser makes is the single
     worst failure mode this extension has: it would send your production
     token to every site you visit. So a profile carrying one must name where
     it applies, unless the user has explicitly accepted the risk for this
     profile. */
  if (settings.requireExplicitHosts && !profile.allowGlobalSensitive && !isHostRestricted(profile.match)) {
    reasons.push('no-host-restriction');
  }

  if (settings.credentialStorage === 'vault' && !unlocked) {
    reasons.push('vault-locked');
  }

  if (settings.warnOnInsecureHosts) {
    const hosts = insecureHosts(profile.match);
    if (hosts.length) warnings.push({ kind: 'insecure-host', hosts });
  }

  /* Fail closed, in two distinct cases:
       - a header referencing a secret that will not resolve, and
       - a credential-bearing header with no secretId at all, which arises from
         a hand-edited config or a partially completed import.
     The second case must never fall through to sending whatever inline value
     the object happens to carry. */
  if (resolvedIds) {
    const unresolvable = sensitive.filter((h) => h.secretId && !resolvedIds.has(h.secretId));
    const unmanaged = sensitive.filter((h) => !h.secretId);

    if (unresolvable.length || unmanaged.length) {
      missingSecretIds = [...new Set(unresolvable.map((h) => h.secretId!))];
      unmanagedHeaders = [...new Set(unmanaged.map((h) => h.name))];
      reasons.push('missing-credential');
    }
  }

  return {
    hasSensitive,
    blocked: reasons.length > 0,
    reasons,
    warnings,
    missingSecretIds,
    unmanagedHeaders,
  };
}

export function describeBlock(reasons: readonly BlockReason[]): string {
  if (reasons.includes('no-host-restriction')) {
    return 'This profile sends a credential. Add a domain or URL filter before it can be used.';
  }
  if (reasons.includes('vault-locked')) {
    return 'Unlock the vault to use this credential.';
  }
  if (reasons.includes('missing-credential')) {
    return 'Enter the credential to activate this profile.';
  }
  return '';
}
