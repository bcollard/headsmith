/* Validating the domain list.
 *
 * `requestDomains` takes hostnames, not patterns. Two consequences that are
 * not obvious and that Chrome will not tell you about:
 *
 * **A domain already covers its subdomains.** A rule naming `example.com`
 * matches `example.com`, `api.example.com` and `a.b.example.com`. There is no
 * wildcard syntax because none is needed. Verified against Chrome rather than
 * taken from the documentation.
 *
 * **Chrome accepts spellings that can never match.** `*.example.com`,
 * `https://example.com`, `example.com:8080` and a bare `*` are all accepted
 * without complaint, and then match nothing, ever -- the value is compared
 * against a request's host, and none of those is a host. The only thing Chrome
 * rejects outright is a non-ASCII character.
 *
 * A rule that is accepted and silently does nothing is the worst failure this
 * extension can produce: the user sees a configured profile, believes it is
 * working, and has nowhere to look. So these are caught in the editor, with a
 * correction rather than a complaint -- every one of them has an obvious
 * intended meaning.
 */

export interface DomainProblem {
  readonly value: string;
  readonly message: string;
  /** What the user almost certainly meant, when that is unambiguous. */
  readonly suggestion?: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function checkDomain(raw: string): DomainProblem | null {
  const value = raw.trim();
  if (!value) return null;

  if (/[^\x20-\x7e]/.test(value)) {
    return { value, message: 'Chrome rejects non-ASCII characters here. Use the punycode form.' };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    const rest = value.slice(scheme[0].length).replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    return {
      value,
      message: 'This matches on the host only, so the scheme has to go.',
      ...(rest ? { suggestion: rest } : {}),
    };
  }

  if (value === '*' || value === '*.*') {
    return {
      value,
      message: 'A bare wildcard never matches. Leave Domains empty to apply everywhere.',
    };
  }

  if (value.startsWith('*.')) {
    const rest = value.slice(2);
    return {
      value,
      message: `Wildcards never match here — and are not needed, because "${rest}" already covers its subdomains.`,
      suggestion: rest,
    };
  }

  if (value.includes('*')) {
    return { value, message: 'Wildcards never match here. Use a plain hostname.' };
  }

  if (value.startsWith('.')) {
    const rest = value.replace(/^\.+/, '');
    return {
      value,
      message: 'A leading dot never matches. Subdomains are already covered.',
      ...(rest ? { suggestion: rest } : {}),
    };
  }

  const port = /^(.*):(\d+)$/.exec(value);
  if (port) {
    return {
      value,
      message: 'Ports are not part of the host match, so this never matches.',
      ...(port[1] ? { suggestion: port[1] } : {}),
    };
  }

  if (value.includes('/')) {
    const host = value.split('/')[0] ?? '';
    return {
      value,
      message: 'This matches the host only. Put the path part under "URL contains".',
      ...(host ? { suggestion: host } : {}),
    };
  }

  /* An IP address is a perfectly valid host and matches only itself -- worth
     saying, because someone who writes 127.0.0.1 while browsing localhost will
     otherwise wonder why nothing happens. */
  if (IPV4.test(value)) return null;

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value)) {
    return { value, message: 'This does not look like a hostname.' };
  }

  return null;
}

export function checkDomains(values: readonly string[]): DomainProblem[] {
  return values.map(checkDomain).filter((p): p is DomainProblem => p !== null);
}

/* Applies every unambiguous suggestion. Offered as a button rather than done
   silently: rewriting what someone typed without asking is its own kind of
   confusing. */
export function repairDomains(values: readonly string[]): string[] {
  const out = values.map((value) => checkDomain(value)?.suggestion ?? value.trim());
  return [...new Set(out.filter(Boolean))];
}
