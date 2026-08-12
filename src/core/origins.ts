/* Which host permissions a profile actually needs.
 *
 * Headsmith asks for no hosts at install. It requests them at the moment a
 * profile names one, so the browser's permission prompt reflects what you
 * configured rather than what you might one day configure.
 *
 * `declarativeNetRequest` requires host access for `modifyHeaders` at the time
 * a request is made -- verified, not assumed: with host permissions narrowed to
 * a single origin the rule applies there and nowhere else. `activeTab` cannot
 * substitute, because its grant arrives on a user gesture, which is after the
 * navigation whose headers you wanted to change.
 *
 * ## Why a domain is enough even with URL filters
 *
 * A compiled condition combines `requestDomains` with `urlFilter` or
 * `regexFilter` as an AND. So once a profile names a domain, no request outside
 * that domain can match it, whatever the URL terms say -- and granting those
 * domains is sufficient.
 *
 * The reverse is not true. A profile scoped *only* by URL substring or regex
 * can match any host in the world, so nothing narrower than full access will
 * do. That is the honest boundary of this feature, and it is surfaced rather
 * than hidden: those profiles ask for broad access explicitly, and the user can
 * decline and add a domain instead.
 */

import { hasSensitiveContent } from './sensitivity';
import type { Config, MatchSet, Profile } from './schema';

/** The pattern that grants access to every host. */
export const ALL_URLS = '*://*/*';

/* A Chrome match pattern for one domain.
 *
 * `*.example.com` matches `example.com` itself as well as its subdomains,
 * which lines up exactly with what `requestDomains` matches -- so the
 * permission granted is neither wider nor narrower than the rule it serves. */
export function originForDomain(domain: string): string {
  return `*://*.${domain.trim().toLowerCase()}/*`;
}

export interface OriginNeed {
  /** Patterns to pass to chrome.permissions.request. */
  readonly origins: readonly string[];
  /** True when the scoping cannot be reduced to specific hosts. */
  readonly needsAllUrls: boolean;
}

const NOTHING: OriginNeed = { origins: [], needsAllUrls: false };

export function originsForMatch(match: MatchSet): OriginNeed {
  if (match.include.domains.length > 0) {
    return {
      origins: [...new Set(match.include.domains.map(originForDomain))],
      needsAllUrls: false,
    };
  }
  /* No domain: either URL-only scoping, which can match any host, or no
     scoping at all, which explicitly means everywhere. Both need everything. */
  return { origins: [ALL_URLS], needsAllUrls: true };
}

/* A profile that would emit no rules needs no permission. Someone who has
   created a profile and not filled it in yet should not be prompted. */
export function profileNeedsHosts(profile: Profile): boolean {
  if (!profile.enabled) return false;
  const live = [...profile.requestHeaders, ...profile.responseHeaders].filter(
    (header) => header.enabled && header.name.trim().length > 0,
  );
  return live.length > 0;
}

export function originsForProfile(profile: Profile): OriginNeed {
  return profileNeedsHosts(profile) ? originsForMatch(profile.match) : NOTHING;
}

export function originsForConfig(config: Config): OriginNeed {
  /* Global exclusions compile to `allow` rules, which Chrome classes as safe
     and applies without host access, so they add nothing here. */
  const origins = new Set<string>();
  let needsAllUrls = false;

  for (const profile of config.profiles) {
    const need = originsForProfile(profile);
    if (need.needsAllUrls) needsAllUrls = true;
    for (const origin of need.origins) origins.add(origin);
  }

  /* Broad access subsumes everything else, so asking for both would show the
     user a longer prompt describing no additional access. */
  if (needsAllUrls) return { origins: [ALL_URLS], needsAllUrls: true };
  return { origins: [...origins], needsAllUrls: false };
}

/* Whether a set of granted patterns covers what a profile needs.
 *
 * Deliberately a plain containment check rather than an attempt to reimplement
 * Chrome's match-pattern algebra. The one case worth understanding is broad
 * access, which really does cover everything; beyond that, the authority on
 * whether a permission is held is `chrome.permissions.contains`, and this is
 * only used to decide what to show. */
export function isCovered(need: OriginNeed, granted: readonly string[]): boolean {
  if (granted.includes(ALL_URLS) || granted.includes('<all_urls>')) return true;
  return need.origins.every((origin) => granted.includes(origin));
}

export interface PermissionGap {
  readonly profileId: string;
  readonly profileName: string;
  readonly origins: readonly string[];
  readonly needsAllUrls: boolean;
  /** A profile sending a credential without host access fails silently twice over. */
  readonly hasCredential: boolean;
}

/* Profiles configured to do something they currently cannot.
 *
 * Chrome enforces this itself: a rule whose host is not granted simply does
 * not apply. Headsmith does not try to predict that in the compiler -- doing so
 * would mean maintaining a second, divergent copy of Chrome's rules. It only
 * reports the gap, so the answer to "why is nothing happening" is on screen
 * rather than in a support thread. */
export function permissionGaps(config: Config, granted: readonly string[]): PermissionGap[] {
  const gaps: PermissionGap[] = [];
  for (const profile of config.profiles) {
    const need = originsForProfile(profile);
    if (need.origins.length === 0) continue;
    if (isCovered(need, granted)) continue;
    gaps.push({
      profileId: profile.id,
      profileName: profile.name,
      origins: need.origins,
      needsAllUrls: need.needsAllUrls,
      hasCredential: hasSensitiveContent(profile),
    });
  }
  return gaps;
}

/* Turns a pattern back into something a person recognises, for UI copy. */
export function describeOrigin(origin: string): string {
  if (origin === ALL_URLS || origin === '<all_urls>') return 'every site';
  const match = /^\*:\/\/\*\.(.+)\/\*$/.exec(origin);
  return match ? match[1]! : origin;
}
