# Security

Headsmith modifies HTTP headers. That means it sits in the path of your
authenticated traffic, and it is the sort of extension that is worth being
suspicious of. This document is the argument for why it is safe, written so
that you can check it rather than take it on faith.

## The central claim: Headsmith cannot see your traffic

Headsmith is built on `declarativeNetRequest` and nothing else. It hands the
browser a list of rules and the browser applies them. The extension is never
invoked for a request. It does not receive the URL, the headers, the body, the
response, or the fact that the request happened at all.

This is not a policy we follow. It is the shape of the API. There is no code
path in Headsmith that could log your traffic, because no code of ours runs
when a request is made.

The contrast worth drawing is with the same feature built on blocking
`webRequest`, which is how the Firefox builds of several header extensions
work — including OpenModHeader, which this project takes its feature set from.
A blocking `webRequest` listener receives every request and every response
header on every site the extension is permitted to touch, and must be trusted
not to do anything with them. Headsmith requests no such permission, and
`webRequest` is on the forbidden list in
[`scripts/permissions-baseline.json`](scripts/permissions-baseline.json) so it
cannot be added without the guard failing.

## Permissions

The full set is four entries. Each is justified in
[`scripts/permissions-baseline.json`](scripts/permissions-baseline.json), and
CI fails if the built manifest drifts from that file.

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | The only header-modification mechanism used. Deliberately not `declarativeNetRequestFeedback`, which would expose which rules matched which requests. |
| `storage` | `storage.local` for profiles, settings and vault ciphertext; `storage.session` for the derived vault key, which is cleared when the browser exits. |
| `alarms` | Drives the vault auto-lock deadline. |
| `<all_urls>` | **Not requested.** See below. |

### Host access is optional, and asked for one domain at a time

Headsmith requests **no host access at install**. The install prompt says
nothing about websites, because at that point the extension has been granted
nothing.

Access is requested when a profile first names a domain, and only for that
domain. Name `api.example.com` and Chrome asks about `api.example.com`. The
grant is per-site, visible in Chrome's extension settings, and revocable there
without uninstalling anything.

This replaces an earlier `<all_urls>` grant. The argument for that grant was
that the hosts are chosen at runtime and so cannot be listed at build time —
which is true, and is precisely what optional permissions exist for. The
install prompt it produced said *"Read and change all your data on all
websites"*, which was frightening and, on the "read" half, simply untrue.

**Broad access remains available, deliberately.** *Settings → Site access*
lists what is granted, removes any of it, and offers a single switch to allow
every site. Hiding that would not reduce how often it is granted — it would
only mean people reach it sideways, by writing a URL filter until the
per-profile control offers it. An escape hatch that is visible and revocable
is safer than one that is neither.

**The honest boundary.** A profile scoped only by URL substring or regular
expression can match a URL on any host, so nothing narrower than full access
can serve it. Those profiles ask for broad access explicitly, and say why
before the prompt appears. Scoping by domain instead is one field away and the
UI says so.

**Why not `activeTab`.** The Web Store review suggests it, and it cannot work
here — verified rather than assumed. `declarativeNetRequest` needs host access
at the moment a request is made; `activeTab` grants it on a user gesture, which
happens after the navigation whose headers were to be modified, and is revoked
on the next navigation. Loading a build with `activeTab` and no host
permissions applies no headers at all. It is sound advice for content scripts
and inapplicable to a declarative header rewriter.

What still bounds the broad grant, for anyone who chooses it: the permission
allows *modifying* headers, not observing anything. `declarativeNetRequest`
hands no request, response, header value or URL to the extension.

## Invariants, and how each one is enforced

These are checked in CI on every pull request. A comment is not an enforcement
mechanism; each of these has a job that fails the build.

| Invariant | Enforced by |
| --- | --- |
| No network egress, ever | [`scripts/guard-egress.mjs`](scripts/guard-egress.mjs) — scans the **built bundle** for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `importScripts`, native messaging and `setUninstallURL` |
| No remote subresources | The same guard, scanning every built HTML file for off-origin `src`/`href`/`action`, every `<link rel=preconnect/preload>`, and every CSS `url()` and `@import` |
| No plaintext secrets at rest | A test that writes a sensitive header, dumps the fake `storage.local`, and asserts the cleartext appears nowhere in it |
| `storage.sync` never receives a secret | There is no `storage.sync` code path at all in v1 — enforced by absence, which is a stronger guarantee than a filter |
| No dynamic code execution | `no-eval`, `no-implied-eval`, `no-new-func` as lint errors, plus MV3's own CSP |
| Least permission | [`scripts/guard-manifest.mjs`](scripts/guard-manifest.mjs) — diffs the built manifest against a reviewed baseline and requires a written justification for every entry |

### Why the egress guard reads `dist/` and not `src/`

Because the bug it is modelled on is only visible in `dist/`.

FlexHeader — the project this one takes its engineering approach from — ships
a `<link rel="stylesheet">` to `fonts.googleapis.com` in its published
`v1.9.6.zip`, alongside a store listing that states it collects no data. MV3's
default CSP does not restrict `style-src` or `font-src`, so the stylesheet
loads, and every popup open hands Google an IP address, a user agent and a
timestamp.

The tag lives in one entrypoint HTML file. A scan of the React source tree
walks straight past it. It only becomes visible in build output. Any guard
that reads source rather than artifact would have missed the single real
privacy bug in the project it was written to learn from — so this one asserts
against the artifact.

## Credential handling

Header values marked sensitive are never stored in a profile. The profile
holds a reference; the value lives in the secret store.

Two storage modes:

- **Session only (default).** Values live in `storage.session`, which Chrome
  clears when the browser exits. Nothing touches disk. You re-enter
  credentials after a restart.
- **Encrypted vault.** Values are AES-GCM encrypted under a key derived from
  your passphrase with PBKDF2-SHA256 at 600,000 iterations. Ciphertext lives in
  `storage.local`; the derived key lives only in `storage.session` and is
  dropped on lock. Auto-lock is driven by `alarms`.

There is deliberately no persistent-plaintext mode. OpenModHeader offers one;
it is the only path by which a credential reaches disk unencrypted, and
keeping it would have made the plaintext-secret guard unwritable without an
exception.

`chrome.storage.session` defaults to the `TRUSTED_CONTEXTS` access level,
which keeps its contents out of content scripts. Headsmith never calls
`setAccessLevel`, and the egress guard fails the build if that call appears in
the bundle.

### Fail-closed

If a credential cannot be resolved — vault locked, secret missing, a
hand-edited config referencing a secret that does not exist — the operation
that needed it is skipped. The rest of the profile still applies. An empty
value is never substituted for a secret, because a request carrying
`Authorization:` with nothing after it is worse than a request carrying no
`Authorization` at all.

### Limits of client-side encryption

The vault protects credentials at rest against someone reading your browser
profile directory. It does not protect against malware running as you while
the vault is unlocked, nor against anyone with your passphrase. A local
attacker with code execution in your user account can read the derived key out
of `storage.session` while the vault is open. Auto-lock is the mitigation for
an unattended machine; it is not a mitigation for a compromised one.

## Release integrity

You cannot, in general, verify that the artifact a developer uploaded to the
Chrome Web Store was built from the public source. The Web Store signs the
`.crx` itself from an uploaded `.zip`; the developer never signs anything, and
nothing links the published bytes to a commit.

Headsmith closes that gap:

- the build is reproducible — same commit, same output, byte for byte;
- releases publish the exact `.zip` uploaded to the store, with GitHub build
  provenance attestation;
- the bundle is **not minified**, so a reviewer can read it.

The commands to check this yourself are in the README. This is the one part of
the security story that does not require trusting us at all.

## Provenance of the credential-security code

Worth stating on a page that asks you to trust this code: the credential-security
*model* here is not original. Storing values under a reference rather than in the
profile, the session-only and encrypted-vault modes, failing closed when a
credential will not resolve, and requiring a host restriction before a credential
applies are all OpenModHeader's design, and the reason to adopt it was that it is
a good one.

The implementations are this project's, and several differ deliberately. The one
worth naming here: each vault record is sealed with its own secret id as AES-GCM
additional authenticated data, so a record moved between ids fails to decrypt.
Without that, hand-editing the vault file to swap two ciphertexts produces a file
that decrypts perfectly and sends the wrong credential to the wrong host.

What this means for you: a design flaw in OpenModHeader's model may well apply
here too, and an advisory against it is worth reading as though it were against
Headsmith. An implementation bug in its code is not.

Itemised in [NOTICE.md](NOTICE.md).

## Reporting a vulnerability

Open a private security advisory through GitHub's "Report a vulnerability"
button on the Security tab. Please do not open a public issue for anything
that affects credential handling or rule integrity.

## Changelog of security-relevant changes

Any change to the permission set, the credential model or the invariant guards
is recorded here. CI requires an entry in this section for permission changes.

- **1.3.0** — Site access made visible and revocable from Settings, with a
  deliberate switch for granting every site. No change to what is requested or
  held; this only makes the existing state inspectable and reversible from
  inside the extension rather than only from Chrome's settings.
- **1.2.0** — `<all_urls>` removed. Host access is now optional and requested
  at runtime, per domain, from a user gesture. `optional_host_permissions` is
  `*://*/*`, granted only when a profile's scoping cannot be reduced to
  specific hosts. This narrows what the extension holds; nothing is widened.
- **1.0.0** — initial permission set: `declarativeNetRequest`, `storage`,
  `alarms`, `<all_urls>`.
