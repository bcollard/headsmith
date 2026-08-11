/* The single decision point for whether a profile's credential-bearing rules
 * may be applied.
 *
 * Gating credentials on an explicit host restriction is OpenModHeader's idea
 * (MIT, (c) 2026 Shiva M). How it is decided here is not -- see the note on the
 * positive test below, and NOTICE.md.
 *
 * Everything here is decidable from a profile, the settings, and the set of
 * secret ids that actually resolved. No storage, no crypto, no clock. That is
 * what makes "would this profile release a credential?" a question a test can
 * ask about a plain object.
 *
 * Two outcomes, kept apart because conflating them is how warnings become
 * noise: `blocked` withholds the credential-bearing rules and nothing else,
 * while `warnings` are worth saying and stop nothing.
 */

import { hasSensitiveContent, sensitiveHeadersOf } from './sensitivity';
import type { MatchSet, Profile, Settings } from './schema';

export type BlockReason = 'no-host-restriction' | 'vault-locked' | 'missing-credential';

export type Warning =
  | { kind: 'insecure-host'; hosts: string[] }
  | { kind: 'broad-match'; detail: string };

export interface Verdict {
  readonly hasSensitive: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly BlockReason[];
  readonly warnings: readonly Warning[];
  readonly missingSecretIds: readonly string[];
  readonly unmanagedHeaders: readonly string[];
}

// ---------------------------------------------------------------------------
// Does this match set actually narrow anything?
// ---------------------------------------------------------------------------

/* The question is whether a filter genuinely restricts traffic, because the
 * answer gates whether a credential may be sent.
 *
 * The tempting implementation is a list of wildcard spellings to reject: a
 * bare star, a scheme-and-star URL pattern, `.*`, `^.*$` and so on. That is a
 * blocklist, and it fails the way blocklists always fail -- it is exactly as
 * good as the imagination of whoever wrote it, and a spelling nobody thought
 * of quietly counts as a restriction. Given that a credential is released on
 * the strength of the answer, that is the wrong direction to fail in.
 *
 * So the test is positive instead. A filter restricts traffic if, once the
 * parts that match anything are removed, some *literal* text survives -- a
 * host label, a path segment, something a request has to actually contain.
 * A pattern made entirely of wildcards leaves nothing behind and fails, with
 * no enumeration required.
 */

/** Values that mean "everything" as a whole and have no literal part. */
const UNIVERSAL = new Set(['*', '<all_urls>', '/', '**', '*/*']);

/** Scheme words carry no restriction on their own: `https://*` is not a host. */
const SCHEME_WORDS = new Set(['http', 'https', 'ws', 'wss']);

/** Shortest run of literal text that counts as naming something. */
const MIN_LITERAL = 3;

/* Strips everything that matches arbitrary text, leaving only literals. */
function literalTokens(value: string): string[] {
  const stripped = value
    .toLowerCase()
    // Regex escapes: \d, \w, \S ... consume the class, not the letter.
    .replace(/\\[a-z]/gi, ' ')
    // A quantified group or class matches arbitrary content.
    .replace(/\[[^\]]*\]/g, ' ')
    // Remaining regex and glob metacharacters.
    .replace(/[*+?^$|(){}.\\/:<>=-]/g, ' ');

  return stripped
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_LITERAL && !SCHEME_WORDS.has(token));
}

export function narrowsTraffic(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return false;
  if (UNIVERSAL.has(trimmed)) return false;
  return literalTokens(trimmed).length > 0;
}

export function isHostRestricted(match: MatchSet): boolean {
  /* A domain include is a restriction by construction -- `requestDomains`
     takes hostnames, not patterns, so there is nothing to analyse. */
  if (match.include.domains.length > 0) return true;

  return (
    match.include.urlContains.some(narrowsTraffic) || match.include.urlRegex.some(narrowsTraffic)
  );
}

// ---------------------------------------------------------------------------
// Insecure destinations
// ---------------------------------------------------------------------------

/* The host in a filter value, if it names one with a scheme. Parsing the host
   out is more precise than searching the whole string: it means `http` can be
   distinguished from `https` without a lookbehind, and the exemption below can
   test the host rather than hoping a substring does not appear elsewhere. */
function schemeAndHost(value: string): { scheme: string; host: string } | null {
  const match = /(?:^|[^a-z])(https?):\/\/([^/?#\s]*)/i.exec(value);
  if (!match) return null;
  return {
    scheme: match[1]!.toLowerCase(),
    host: (match[2] ?? '').toLowerCase().replace(/:\d+$/, ''),
  };
}

/* Development hosts where plaintext http is normal and correct. Warning about
   these would train people to dismiss the warning, which costs more than the
   handful of real cases it would catch. */
function isLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  return /\.(local|localhost|test|internal\.localhost)$/.test(host);
}

export function insecureHosts(match: MatchSet): string[] {
  const candidates = [...match.include.urlContains, ...match.include.urlRegex];
  return candidates.filter((value) => {
    const parsed = schemeAndHost(value);
    return parsed !== null && parsed.scheme === 'http' && !isLocalHost(parsed.host);
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface EvaluateContext {
  /** False when a vault exists but is locked. Always true in session mode. */
  readonly unlocked?: boolean;
  /** Ids that resolved to a value. Omit to skip the resolution check. */
  readonly resolvedIds?: ReadonlySet<string> | undefined;
}

export function evaluateProfile(
  profile: Profile,
  settings: Settings,
  context: EvaluateContext = {},
): Verdict {
  const { unlocked = true, resolvedIds } = context;

  const nothingSensitive: Verdict = {
    hasSensitive: false,
    blocked: false,
    reasons: [],
    warnings: [],
    missingSecretIds: [],
    unmanagedHeaders: [],
  };

  if (!hasSensitiveContent(profile)) return nothingSensitive;

  const live = sensitiveHeadersOf(profile).filter((h) => h.enabled && h.name.trim());
  const reasons: BlockReason[] = [];
  const warnings: Warning[] = [];

  /* A credential attached to every request is this extension's worst possible
     failure: it would hand a production token to every site visited. A profile
     carrying one therefore has to say where it applies. Overridable per
     profile, never globally -- accepting the risk for a local development
     profile must not disarm the one holding the real token. */
  if (
    settings.requireExplicitHosts &&
    !profile.allowGlobalSensitive &&
    !isHostRestricted(profile.match)
  ) {
    reasons.push('no-host-restriction');
  }

  if (settings.credentialStorage === 'vault' && !unlocked) {
    reasons.push('vault-locked');
  }

  if (settings.warnOnInsecureHosts) {
    const hosts = insecureHosts(profile.match);
    if (hosts.length > 0) warnings.push({ kind: 'insecure-host', hosts });
  }

  /* Fail closed, in two distinct shapes:
       - a header pointing at a secret that will not resolve, and
       - a credential-bearing header pointing at nothing at all, which arises
         from a hand-edited config or a half-finished import.
     The second must never fall through to sending whatever inline value the
     object happens to be carrying. */
  const unresolvable = resolvedIds
    ? live.filter((h) => h.secretId !== null && !resolvedIds.has(h.secretId))
    : [];
  const unmanaged = resolvedIds ? live.filter((h) => h.secretId === null) : [];

  if (unresolvable.length > 0 || unmanaged.length > 0) {
    reasons.push('missing-credential');
  }

  return {
    hasSensitive: true,
    blocked: reasons.length > 0,
    reasons,
    warnings,
    missingSecretIds: [...new Set(unresolvable.map((h) => h.secretId!))],
    unmanagedHeaders: [...new Set(unmanaged.map((h) => h.name))],
  };
}

export function describeBlock(reasons: readonly BlockReason[]): string {
  /* Ordered by what the reader can act on first. Someone whose profile is both
     unscoped and locked should be told to add a filter, because unlocking
     alone will not make it work. */
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
