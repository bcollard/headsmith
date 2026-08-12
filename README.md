<div align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="">
  <h1>Headsmith</h1>
  <p><strong>Add, rewrite and remove HTTP headers in Chrome — organised into profiles, scoped by URL.</strong></p>
</div>

---

## Headsmith cannot see your traffic

This is the point of the project, so it goes first.

Headsmith is built on `declarativeNetRequest` and nothing else. It hands the
browser a list of rules and the browser applies them. The extension is never
invoked for a request. It does not receive the URL, the headers, the body, the
response, or the fact that the request happened.

That is not a promise about our conduct. It is the shape of the API — there is
no code path that *could* log your traffic, because none of our code runs when
a request is made.

Compare the same feature built on blocking `webRequest`, which is how several
header extensions work: that receives every request and every response header
on every site it is permitted to touch, and has to be trusted not to act on
them. Headsmith does not request that permission, and `webRequest` is on a
hard-fail list in CI so it cannot be added quietly.

## Verify the build yourself

You do not have to trust that the extension in the Web Store was built from
this source. You can check.

```bash
git clone https://github.com/bcollard/headsmith.git && cd headsmith
git checkout v1.0.0        # the tag you want to verify
nvm use                    # matches .nvmrc — the Node version affects the output
npm ci
node scripts/verify-reproducible.mjs ~/Downloads/headsmith-1.0.0.zip
```

The build is a pure function of the source: fixed timestamps, sorted archive
entries, no metadata from the build machine. Two builds of the same commit
produce byte-identical archives, on any machine, in any directory.

And to confirm the artifact came from this repository:

```bash
gh attestation verify headsmith-1.0.0.zip --repo bcollard/headsmith
```

The shipped bundle is **deliberately not minified**. Publishing with provenance
is worth little if the thing being attested is a 400KB unreadable chunk, so the
JavaScript in the release is the JavaScript you can read.

This matters because of a gap most extensions leave open: the Chrome Web Store
signs the `.crx` itself from an uploaded `.zip`. The developer never signs
anything, and nothing links the published bytes to a commit. Reproducibility
plus attestation is what closes it.

## What it does

- **Request and response headers** — set, append, remove.
- **Profiles** — group rules, switch between them, enable and disable
  individually, pause everything with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>.
- **Scoping** — by domain, URL substring, URL regex, and resource type, with
  per-profile domain exclusions and a global "never touch these URLs" list.
- **Credential handling** — header values recognised as credentials are stored
  separately from the profile, either in session-only memory or in a
  passphrase-encrypted vault.

### What it deliberately does not do

Chrome's `declarativeNetRequest` cannot *read* an existing header value. That
rules some things out, and Headsmith says so rather than shipping a degraded
version under a name that implies otherwise:

- **No cookie merge.** True merge means "overwrite this one cookie, keep the
  rest", which requires reading the outgoing `Cookie` header. Not possible.
- **No CSP directive merge.** Same reason: a policy can be replaced wholesale,
  not surgically edited.
- **No traffic inspection**, by construction.

## Security

Six invariants, each enforced by a CI job rather than a comment:

| Invariant | Enforced by |
| --- | --- |
| No network egress, ever | A guard that scans the **built bundle** for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource` and native messaging |
| No remote subresources | The same guard, over every built HTML and CSS file |
| No plaintext secrets at rest | A test that writes a credential and asserts the cleartext appears nowhere in a dump of storage |
| `storage.sync` never sees a secret | There is no `storage.sync` code path at all |
| No dynamic code execution | Lint rules plus MV3's own CSP |
| Least permission | A guard that diffs the built manifest against a reviewed baseline |

The guards read `dist/`, not `src/`, and that distinction is deliberate — the
bug they were modelled on is a remote font stylesheet that is invisible in a
source tree and only appears in build output.

Four permissions: `declarativeNetRequest`, `storage`, `alarms`, and
`<all_urls>`. Each is justified in
[`scripts/permissions-baseline.json`](scripts/permissions-baseline.json), and
the broad host grant is argued for honestly in [SECURITY.md](SECURITY.md).

**Four runtime dependencies**: React, React DOM, Zod, and React's scheduler.
Everything else in the tree is build-time only and never reaches your browser.

## Credentials

Header values that look like credentials — `Authorization`, `X-Api-Key`,
anything matching the patterns in
[`src/core/sensitivity.ts`](src/core/sensitivity.ts) — are never stored inside a
profile. The profile holds a reference; the value lives in the secret store.

Two modes:

- **Session only** *(default)* — values live in `storage.session`, which Chrome
  clears when the browser exits. Nothing touches disk. You re-enter credentials
  after a restart.
- **Encrypted vault** — AES-GCM under a key derived from your passphrase with
  PBKDF2-SHA256 at 600,000 iterations. Ciphertext in `storage.local`, key in
  `storage.session` only, dropped on lock, with an idle auto-lock.

There is no persistent-plaintext mode.

Two behaviours worth knowing:

- **Fail closed.** If a credential cannot be resolved, the operation needing it
  is skipped and the rest of the profile still applies. An empty value is never
  substituted — a request carrying `Authorization:` with nothing after it is
  worse than one carrying no `Authorization` at all.
- **A credential needs a scope.** A profile carrying one must name a domain or
  URL before its rules apply, so a production token cannot be attached to every
  request your browser makes. Overridable per profile, never globally.

## Try it locally

Not yet published, so run it from source:

```bash
npm ci
npm run build
```

Load it into Chrome:

1. Open `chrome://extensions` (or `make load`)
2. Turn on **Developer mode**, top right
3. **Load unpacked** → select `dist/chrome`

Then check it actually does something. In a second terminal:

```bash
npm run echo        # a local echo server on http://localhost:8787
```

Open <http://localhost:8787>. It lists the request headers the server really
received, with anything your browser would not normally send called out
separately. It is local on purpose — testing a privacy extension should not
mean posting your headers to somebody else's server, and a credential you are
experimenting with should stay on your machine.

Now open the Headsmith popup, add a header — say `X-Environment: staging` — and
under **Scope** put `localhost` in Domains. Reload the echo page and it will be
there.

A few things worth trying, because they are where the behaviour is opinionated:

- **Name a header `Authorization`.** The value field is replaced by a credential
  field the moment the name is recognised. What the profile stores is a
  reference; the value goes to the secret store.
- **Leave the scope empty on that profile.** It refuses to apply and says why —
  a credential must name where it is allowed to go.
- **Set a response header.** Then read the next section, because checking this
  one is genuinely counter-intuitive.
- **Press Alt+Shift+H.** Everything stops, and nothing is lost.

After a rebuild, click the reload icon on the extension card in
`chrome://extensions`.

### Response headers are hard to verify, and both obvious methods lie

This is the single most confusing thing about any extension that modifies
response headers, so it is worth stating plainly.

**DevTools does not show them.** The Network panel reports response headers as
they arrived from the server, before extensions modify them. A header you set
here can be applied correctly and still be absent from that list. Nothing is
wrong.

**`fetch(...).headers.get(...)` does not show them either**, on a cross-origin
page. CORS exposes only a safelisted set of response headers to JavaScript, so
a custom one reads as `null` whether or not it arrived.

To actually confirm a response header is working, use one with a visible
effect. Set `Content-Type` to `text/plain` on a page that returns JSON: if it
stops rendering as formatted JSON and becomes raw text, response headers are
being applied. Chrome had to have read the modified header to parse it that
way.

The local echo server is the other way — it shows you what the server received
and lets you fetch the page back same-origin, where CORS does not apply.

## Development

```bash
make help          # what you can do
make dev           # hot-reloading development build
make check         # everything CI runs, in the same order
make e2e           # end-to-end against a real loaded Chrome
```

The architecture in one line: **`src/core` decides, `src/platform` touches the
browser, and `src/core` may not import `chrome`** — enforced by a lint rule and
a CI guard. That is what lets the rule compiler be snapshot-tested against JSON
fixtures in milliseconds, without a browser.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Prior art, honestly

Headsmith is not a fork, but a substantial part of it is derived work, and the
credential-security model in particular is a TypeScript port of
[OpenModHeader](https://github.com/Multivalence/OpenModHeader)'s. The
snapshot-fixture testing pattern comes from
[FlexHeader](https://github.com/harrisondeo/FlexHeader). Both are MIT licensed.

[NOTICE.md](NOTICE.md) itemises every derived file, what came from where, and
what changed — in enough detail to check rather than take on trust.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
