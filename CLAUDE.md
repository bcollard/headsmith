# CLAUDE.md

Working notes for this repository: decisions, the reasoning behind them, and
the traps. If something here looks arbitrary, it usually is not — the reason is
recorded next to it.

## What this is

A Chrome-only MV3 extension that modifies HTTP headers, built on
`declarativeNetRequest` and nothing else. The central property is that it
**cannot observe traffic**: rules are handed to the browser, and no extension
code runs when a request is made.

Every design argument in this file ultimately serves that property or the
credential handling around it.

## Comment style

Comments explain **why**, never what. A comment that restates the line below it
is deleted. A comment earns its place by recording a decision, a constraint, a
trap, or a bug that was actually hit.

Where a comment explains an inherited design, say where it came from. Where it
explains a departure, say what the alternative was and why it lost.

## Architecture: the one rule

**`src/core` may not import `chrome`.**

```
src/core/        decides things       pure — no browser APIs, no I/O, no clock
src/platform/    touches the browser  thin forwards to chrome.*
src/background/  wires them together
src/ui/          React
```

Enforced twice: an eslint rule (author time) and `scripts/guard-core-purity.mjs`
(CI, and it resolves import paths so a transitive reach through `src/platform`
also fails).

This is load-bearing, not stylistic. It is what makes the rule compiler
snapshot-testable in milliseconds without a browser, and what makes "would this
profile release a credential?" answerable from a plain object — which is the
basis of the plaintext-secret test.

When `src/core` needs something from the browser, the caller fetches it and
passes it in. `compile()` takes a resolver function, not a storage handle.

## The four layers of the compiler, and why they are separate

```
sensitivity.ts   is this value a credential?
policy.ts        may this profile release one?
plan.ts          what should happen to which headers?
compile.ts       what rules express that?
```

The split is so the fail-closed credential logic can be tested without
reasoning about rule ids and priorities, and so Chrome's constraints stay in one
file. Merging any two of these makes both harder to test.

## declarativeNetRequest constraints that shaped the design

These were verified against current Chrome documentation, not assumed.

### The rule budget is not the number people quote

Chrome 121 raised `MAX_NUMBER_OF_DYNAMIC_RULES` to 30,000. That figure is
**irrelevant here**: it applies only to *safe* actions — `block`, `allow`,
`allowAllRequests`, `upgradeScheme`. `modifyHeaders` is unsafe, so the binding
limit is `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` = **5,000**.

The tighter limit almost nobody accounts for is **1,000 regex rules per rule
set** — five times scarcer. `src/core/budget.ts` tracks both and the pressure
meter reports whichever ceiling is closest, so a config that is fine on rule
count but nearly out of regex slots reads as nearly full.

Practical consequence: prefer `requestDomains` (free) over `urlFilter`, and
`urlFilter` over `regexFilter`. A "match everything" condition is an *empty*
condition — never a catch-all regex.

### Rules are bucketed by condition, not by header

Every header sharing a condition goes into one rule's `requestHeaders` array.
12 headers × 8 filters is **8 rules, not 96**. This is the difference between a
realistic configuration fitting in the budget and not.

### `allow` is global, so URL exclusions are too

A DNR `allow` rule at higher priority suppresses every lower-priority rule from
*every* profile, not just the one it was configured on. There is no way to
scope it.

So URL exclusions live at config level and are labelled "never modify these
URLs", which is what the mechanism actually does. Per-profile exclusion is
offered only as `exclude.domains`, which compiles to `excludedRequestDomains`
*inside* the condition and genuinely is scoped.

Do not add per-profile URL exclusion. It cannot work, and presenting it as
though it does is worse than not having it.

### RE2 has no lookaround

Which is why the exclusion problem above has no clever regex workaround. The
chrome fake rejects lookaround so this fails in a unit test rather than at
runtime.

### Things DNR simply cannot do

It cannot read an existing header value. Therefore: no true cookie merge, no
CSP directive merge. Both were cut rather than shipped in a degraded form under
a name implying otherwise.

## Credential handling

### Two modes, and never a third

`session` (values in `storage.session`, cleared on browser exit) and `vault`
(AES-GCM under a PBKDF2-derived key). **There is no persistent-plaintext mode.**
OpenModHeader has one; it is the only path by which a credential reaches disk
unencrypted, and keeping it would have required an exception in the
plaintext-secret guard. An exception in that guard is the guard.

### Credentials only ever become session rules

Chrome persists dynamic rules to disk and does not persist session rules. That
is what makes "a token never touches disk unencrypted" true of the *rule set*
as well as of storage. `compile()` routes by sensitivity and the fixtures pin
it.

### Locking removes rules, not just the key

Forgetting how to decrypt a credential does not stop the browser from
continuing to send a rule it was already handed. `lock()` and
`clearSessionRules()` go together — always.

### Fail closed

An unresolvable credential means the operation is *dropped*, never sent empty.
A request carrying `Authorization:` with nothing after it is worse than one
carrying no `Authorization`: the first reads as a failed auth attempt and can
lock an account or burn a rate limit.

The rest of the profile still applies. A locked vault must not stop an
unrelated `X-Debug` header from working.

### A credential needs a scope

A profile carrying one must name a domain or URL before its rules apply.
Overridable per profile (`allowGlobalSensitive`), never globally — accepting
the risk once for a local dev profile must not disable the protection for the
one holding a production token.

`isHostRestricted` rejects wildcards explicitly. The protection is worthless if
typing `*` satisfies it.

### The reveal path takes a passphrase and does real work with it

`decryptOne` re-derives the key from the vault salt and never reads the cached
one. There is no boolean "was the passphrase correct" to patch out — a wrong
passphrase makes a wrong key and AES-GCM refuses. Keep it that shape.

A wrong passphrase and a corrupt record return *identical* errors. Telling them
apart tells an attacker which they are facing.

## Storage

### Parsing never throws

Config arrives from an older build, an imported file, or someone editing JSON.
Every field has a default and a `.catch()`, so a malformed value degrades to
the default instead of taking the profile list with it. Tested against a corpus
of hostile inputs — add to it rather than trusting a new field.

### Credentials are stripped at the parse boundary

A header with a `secretId` has its inline value forced empty in the schema, not
in the UI. A hand-edited config cannot smuggle a plaintext token into
`storage.local` through a field the editor would never have written.

### Migrations exist even though there are none

A tolerant parser turns a *rename* into silent data loss: the old key looks
unknown and gets dropped. Renames therefore go in `src/core/migrations/` as
explicit steps that run before parsing. The registry is empty at v1 and the
machinery is there anyway, because retrofitting it after the first breaking
change is how projects end up with one-off repair code in the worker.

### Two storage keys, and the listener watches only one

The worker writes its status to `storage.local` on every apply. If the change
listener watched every key, each apply would trigger another apply. It watches
`config` only.

## The invariant guards

Five scripts in `scripts/`. They run against **`dist/`, not `src/`** — the bug
they were modelled on is a `fonts.googleapis.com` stylesheet in a shipped
extension, which lives in one entrypoint HTML file and is invisible to a source
scan. A guard reading source would have missed the one real privacy bug in the
project it was written to learn from.

`scripts/egress-allowlist.json` has **no host entries** and should stay that
way. When Vite's modulepreload polyfill put a `fetch()` in the bundle, the fix
was switching the polyfill off (Chrome 110 does not need it), not excusing it.
The guard now asserts *zero* network primitives with no exception.

Identifier URIs — XML namespaces, JSON Schema `$schema` values — are exempted
by **exact prefix, never by host**. An entry for `www.w3.org` would also permit
a genuine `<script src>` from there, which is the thing the guard exists to
catch.

The guards are zero-dependency plain ESM on purpose: a guard that trusts
`node_modules` to verify `node_modules` is not a guard. The JS tokenizer in
`guard-egress.mjs` is hand-rolled for the same reason and has its own tests —
its whole job is telling a `fetch(` in a comment from one in code.

`guard-locales.mjs` is the odd one out: it guards a *listing* rather than the
code. It exists because the failure it catches is silent and expensive — a
manifest placeholder with no message ships as the literal text `__MSG_extName__`
as the extension's name, and the store's name and summary limits (75 and 132
characters) are enforced at submission, which is days after the mistake was
made. It also rejects a summary containing markup or a newline, since that field
is plain text and the dashboard does not say so.

## Reproducible builds

The build is a pure function of the source. Verified across a fresh clone in a
different directory, not just twice in the same one.

Three things had to be removed: timestamps (fixed DOS epoch, not mtime), entry
order (sorted, not readdir), and metadata (no extra fields, no external
attributes). `wxt zip` and `zip -r` both fail on all three, which is why
`scripts/lib/zip.mjs` exists.

`minify: false` is deliberate. Publishing with provenance is worth little if
the attested thing is an unreadable 400KB chunk.

The one input outside the repo is the **Node version**, because zlib ships with
Node. Hence `.nvmrc`, used verbatim in CI and recorded in release notes.

Icons are *generated*, not committed as hand-made binaries, so the artifact is
entirely source-derived. The encoder is dependency-free specifically because
`sharp`/`resvg` ship per-platform native binaries that would make a macOS build
differ from a CI one — and the whole claim would die on an icon diff.

## Provenance

Substantial parts of this are ported from OpenModHeader — the entire credential
layer. See `NOTICE.md`, which itemises it file by file.

This matters when reading the security code: a flaw in the original is very
likely a flaw here. An advisory against OpenModHeader's credential handling
should be treated as applying here until checked.

## Diagnosing "my rule is not firing"

In order of how often it turns out to be the cause:

1. **The Domains value is not a hostname.** `*.example.com`,
   `https://example.com`, `example.com:8080` and a bare `*` are all accepted by
   Chrome and then match nothing. `src/core/domains.ts` flags these in the
   editor; if someone is on an older build, they will not see the warning.
2. **A stale unpacked build.** Chrome does not reload `dist/` on its own. The
   reload button on the extension card is required after every rebuild.
3. **The response was cached.** No network response, no rule application.
4. **Checking a response header at all.** Both obvious methods lie:

   - **DevTools' Network panel reports response headers as they arrived from
     the server**, before extension modification. A correctly applied header is
     simply absent from that list.

     The mechanism, since it was guessed at wrongly twice before being
     measured: Chrome emits the headers over CDP twice.
     `Network.responseReceived` carries the processed headers and *does*
     contain the modification; `Network.responseReceivedExtraInfo` carries the
     raw on-the-wire headers and does not. The Network panel renders the raw
     one. This is by design and version-independent -- confirmed by a user
     updating Chrome and seeing no change.
   - **`fetch().headers.get()` cross-origin returns `null`** for any
     non-safelisted response header, present or not, because CORS does not
     expose it to script.

   What does work, and is what the UI now tells people, is asking the page for
   itself from its own console:

       (await fetch(location.href)).headers.get('Name')

   Same-origin, so every response header is exposed. Note the request is an
   `xmlhttprequest`, so it will not match a profile restricted to `main_frame`.

   Where script cannot be run, a header with an observable effect works
   instead -- `Content-Type` is the good one, since Chrome must have read the
   modified value to parse the body the way it did.

   Worth noting why the extension cannot simply check this for the user: doing
   so would mean issuing a request, and Headsmith makes none at all. The
   no-egress invariant costs a genuinely useful feature here, and that is the
   right trade, but it is a real cost rather than a free one.

   Both of these produced convincing false negatives during a real
   investigation, one of them mine. The UI carries a note about it under the
   response-header editor, because this will be the most common support
   question the project ever gets.

## Host permissions

**Nothing is granted at install.** `host_permissions` is empty;
`optional_host_permissions` is `*://*/*`, requested at runtime.

`src/core/origins.ts` decides what a profile needs. The rule worth remembering:
a compiled condition ANDs `requestDomains` with any URL term, so **once a
profile names a domain, granting that domain is sufficient however the URL
filters are written**. The reverse does not hold -- a profile scoped only by
URL substring or regex can match any host, and nothing narrower than
`*://*/*` can serve it. That is the honest boundary and it is surfaced in the
UI rather than hidden.

Three things that shaped this, all measured rather than assumed:

- **Narrowed host permissions work.** A build holding one origin applies
  headers there and nowhere else.
- **`activeTab` does not.** A build with `activeTab` and no host permissions
  applies nothing. `declarativeNetRequest` needs host access at the moment a
  request is made; `activeTab` grants it on a user gesture, which happens after
  the navigation whose headers were to be changed, and is revoked by the next
  one. The Web Store review suggests it; it is sound advice for content scripts
  and inapplicable here.
- **`permissions.request` refuses outside a user gesture.** That is the
  property that makes the model worth having, and it is also why Chrome's
  consent bubble cannot be driven by a test.

The compiler does **not** withhold rules for un-granted hosts. Chrome enforces
that itself by declining to act on them, and reimplementing the check would
mean maintaining a second copy of Chrome's rules that could disagree with the
first. `permissionGaps` only *reports* the gap, so the answer to "why is
nothing happening" is on screen.

### Testing around the consent bubble

The tests split. Everything up to the click -- no access at install, no effect
without access, the grant control offered, the request refusing without a
gesture -- runs against the real build. The tests that need a rule to actually
apply run against `dist/chrome-granted`, produced by
`scripts/make-granted-build.mjs`, whose manifest declares localhost outright.
CI builds it explicitly, because the e2e job downloads `dist/` rather than
rebuilding.

One consequence worth knowing: `chrome.permissions.remove` only removes
*optional* permissions, so revocation cannot be exercised from that fixture --
its access is required, not optional. The revoke call is the one part of the
site-access panel with no end-to-end coverage.

## Traps hit while building this

Recorded so they are not hit twice.

- **`applyRules` could throw and leave the extension silently dead.** The
  clear-before-retry call sat outside any try/catch; an engine rejection there
  escaped, so no rules applied *and* no status was written. Every engine call is
  now treated as fallible, including ones that "cannot" fail.
- **`initVault` destroyed user credentials.** It cleared the session cache, so
  a session-mode user who set a vault passphrase lost everything before
  `switchMode` could carry it across. Creating a vault and switching to it are
  different acts.
- **The manifest referenced icons that were not in the build.** A clean build,
  a broken extension. Caught by `guard-manifest-refs.mjs`, which is why that
  guard exists.
- **`wxt@0.20` pulled in the Firefox dev runner** (`web-ext-run`) with 10
  advisories, 3 critical. `wxt@0.21` makes it an optional peer: 0
  vulnerabilities, 214 fewer packages. We are Chrome-only; do not install it.
- **A type-aware eslint rule applied to a file the project service does not
  know about is a hard crash**, not a skipped check. Scope typed rules to
  exactly the globs `tsconfig.json` covers.
- **`"modulepreload"` appears only inside string literals** in Vite's polyfill,
  so a guard matching it against comment-and-string-stripped code never fires.
  Match on identifiers that survive stripping.
