<!-- Detailed description, en. Paste into the dashboard. Max 16 000 chars. -->

Headsmith is a header editor for Chrome. Add, modify or remove HTTP request and
response headers, group the rules into profiles, and scope each profile to the
sites it should apply to.

Useful when you need to send an Authorization or X-Api-Key header to a staging
API, override User-Agent or Accept-Language, add tracing headers to every call
to one service, or strip a header a page is choking on — without changing the
application or reaching for a proxy.

WHAT YOU CAN DO
• Set, append or remove request headers and response headers
• Group rules into profiles, switch between them, enable them one at a time
• Scope by domain, URL substring, regular expression and request type
• Exclude domains per profile, and keep a global never-modify list
• Pause everything with a keyboard shortcut when you need a clean request
• Import and export your configuration
• Dark mode, following your system

IT ASKS FOR NO SITES WHEN YOU INSTALL IT

There is no "read and change all your data on all websites" prompt, because at
install this extension has been granted nothing at all. When a profile names a
domain, Chrome asks about that domain and nothing else. Every site you have
allowed is listed inside the extension and can be withdrawn there.

A profile scoped by URL text or a regular expression rather than a domain can
match any site, so it asks for broader access — and says so before asking.

IT CANNOT READ YOUR TRAFFIC

Headsmith is built entirely on Chrome's declarativeNetRequest API. It hands the
browser a list of rules and the browser applies them; the extension is never
invoked for a request and receives no URL, header, body or response. This is not
a policy — it is the shape of the API.

Reading traffic would require the webRequest permission. Headsmith does not
request it, and a check in the build pipeline fails if that ever changes.

CREDENTIALS ARE KEPT OUT OF YOUR PROFILES

Header values recognised as credentials are never stored inside a profile. By
default they live in session memory that Chrome clears when it closes. If you
prefer them to survive a restart, set a passphrase and they are encrypted with
AES-GCM under a key derived with PBKDF2, held only while the vault is unlocked.

If a credential cannot be resolved, the header is dropped rather than sent
empty — an Authorization header with nothing after it is worse than no header
at all. A profile carrying a credential must also name where it applies, so a
token cannot be attached to every request your browser makes.

YOU CAN VERIFY THE BUILD YOURSELF

Every release is reproducible: rebuild it from source and you get the same bytes,
and each release carries a GitHub provenance attestation binding those bytes to
a commit. The shipped code is not minified, so it can be read. The exact
commands are on the project site.

NO DATA COLLECTION

No analytics, no telemetry, no remote fonts or scripts, and no network requests
of any kind. That is enforced by a check that scans the packaged extension and
fails the build if any network primitive or external host appears in it.

Open source and MIT licensed. Source, security notes and issue tracker:
https://github.com/bcollard/headsmith
