# Publishing to the Chrome Web Store

From a tagged release to a live listing.

## How signing actually works

Worth being clear about, because it shapes everything else: **you never sign
anything.** You upload a plain `.zip`; Google signs it into a `.crx` on their
side, using a key you do not hold.

Which means there is nothing in the published artifact that ties it to your
source. A user downloading Headsmith from the store has Google's word that the
bytes came from your developer account, and nothing at all connecting them to a
commit.

That gap is why this project bothers with reproducible builds and provenance
attestation. The store cannot close it; the release workflow can.

**Consequence for you:** upload the `.zip` attached to the GitHub release, not
one you built locally. If you upload a local build, the attestation published
alongside it describes a different artifact and the verification instructions in
the README become false.

## One-time setup

1. Register at <https://chrome.google.com/webstore/devconsole>.
2. Pay the one-time **$5 USD** developer fee. It is per account, not per
   extension.
3. Accept the developer agreement.

## Assets

All generated, none hand-made. Icons and promo tiles come from one geometry
definition; screenshots are scripted against the real extension.

```bash
npm run icons        # icons, store icon, promo tiles
npm run screenshots  # 1280x800 screenshots (needs a build first)
```

| Asset | Size | Where |
| --- | --- | --- |
| Extension icons | 16 / 32 / 48 / 128 | `src/public/icons/`, bundled automatically |
| Store icon | 128 × 128 | `assets/store/store-icon-128.png` |
| Small promo tile | 440 × 280 | `assets/store/promo-small-440x280.png` |
| Marquee promo tile | 1400 × 560 | `assets/store/promo-marquee-1400x560.png` |
| Screenshots | 1280 × 800 | `assets/store/screenshots/`, via `npm run screenshots` |

```bash
npm run build && npm run screenshots
```

**Do not capture these by hand through DevTools.** On a Retina display the
panel captures at the device pixel ratio, so a 1280 × 800 viewport is written
out as 2560 × 1600 and the store refuses it — with an error that does not
mention the size. The script pins `deviceScaleFactor: 1`, checks every file it
produced, and fails if any is the wrong size. It also clears the directory
first, because the store rejects an entire submission for one stale
wrong-sized image without telling you which one.

The shots are scripted rather than posed, so they are reproducible and stay
current with the UI. They use a realistic profile — the most common rejection
for a developer tool is screenshots that do not demonstrate the described
functionality.

## Release and upload

Tag last, not first. `release.yml` attests whatever the tag points at, so the
commit must already be on `main` with CI green before it is tagged — otherwise
you get a signed attestation for something that was never checked.

```bash
# 1. bump, land on main, let CI go green
npm pkg set version=1.2.0          # or patch/major as appropriate
git commit -am "Release 1.2.0"
git push origin main
gh run watch                        # wait for CI and Security

# 2. only now tag it
git tag -a v1.2.0 -m "Headsmith 1.2.0"
git push origin v1.2.0
```

`release.yml` then re-runs every gate, builds, packages, confirms the build
reproduces, generates the SBOM, attests provenance and publishes.

Download the `.zip` **from the GitHub release page**, then check it before
uploading anything:

```bash
V=1.2.0
gh release download "v$V" --repo bcollard/headsmith -D /tmp/hs
cd /tmp/hs && shasum -a 256 -c SHA256SUMS
gh attestation verify "headsmith-$V.zip" --repo bcollard/headsmith
cd - && node scripts/verify-reproducible.mjs "/tmp/hs/headsmith-$V.zip"
```

All four should pass: checksums match, the attestation names this repository
and that tag, and your own rebuild is byte-identical to the published bytes.

Then: developer console → **New item** → upload the zip. Chrome parses the
manifest and reports validation errors before you go further.

### Before you submit

- [ ] The zip is the one from the release page, not `build/` locally
- [ ] `gh attestation verify` passes on that exact file
- [ ] Screenshots regenerated if the UI changed (`npm run screenshots`)
- [ ] `SECURITY.md` changelog updated if permissions moved
- [ ] The listing text below still matches what the extension does

## What actually distinguishes this, and how to say it

Three properties are genuinely unusual for a header extension. They are worth
leading with, because they are the reason to pick this one and they are all
checkable.

**1. No host access at install.** Most extensions in this category request
`<all_urls>` up front, so installing one shows *"Read and change all your data
on all websites"* before it has done anything. Headsmith requests nothing.
Access is asked for one domain at a time, when a profile names one, and the
prompt says that domain. Site access is listed in the extension's own settings
and can be withdrawn there.

**2. It cannot observe traffic, structurally.** Built on
`declarativeNetRequest` alone: rules are handed to the browser and no extension
code runs when a request is made. The same feature built on blocking
`webRequest` receives every request and response header on every permitted site
and must be trusted not to act on them. This is a property of the API, not a
promise about conduct — which is why it can be stated so flatly.

**3. Releases are reproducible and attested.** The Web Store signs the `.crx`
itself from an uploaded `.zip`, so a store signature says the bytes came from a
developer account and nothing about where they came from. Every Headsmith
release is byte-reproducible from source and carries a provenance attestation
binding it to a commit. Anyone can rebuild and compare.

### Say it about Headsmith, not about other extensions

The listing text below describes what Headsmith does and contrasts *approaches*
— blocking `webRequest` versus declarative rules, install-time access versus
per-domain — without naming another product.

That is deliberate. Comparative claims about named competitors invite reviewer
scrutiny and can fall foul of the Developer Program Policies, and the contrast
does not need them: "this one asks for no sites at install" is a stronger, more
checkable claim than "unlike X". Anyone comparing options will draw the
conclusion themselves, and the factual version cannot be argued with.

## Listing

| Field | Value |
| --- | --- |
| Name | Headsmith |
| Category | Developer Tools |
| Short description | Add, rewrite and remove HTTP headers. Profiles, URL scoping, encrypted credentials, no traffic access. |

Suggested detailed description:

```
Headsmith modifies HTTP request and response headers — organised into
profiles and scoped by domain, URL or regex.

IT CANNOT SEE YOUR TRAFFIC

Headsmith is built entirely on Chrome's declarativeNetRequest API. It hands
the browser a list of rules and the browser applies them. The extension is
never invoked for a request: it does not receive the URL, the headers, the
body, or the response. This is not a policy — it is the shape of the API.

Extensions that modify headers using blocking webRequest do see every
request on every site they are permitted to touch. Headsmith does not ask
for that permission.

IT ASKS FOR NO SITES WHEN YOU INSTALL IT

There is no "read and change all your data on all websites" prompt, because
at install Headsmith is granted nothing at all. When a profile names a
domain, Chrome asks about that domain and nothing else. Every site you have
allowed is listed in the extension's settings and can be withdrawn there.

Profiles scoped by URL text or a regular expression can match any site, so
those ask for broader access — and say so before asking.

FEATURES
• Set, append and remove request and response headers
• Profiles you can switch between, enable individually, or pause entirely
• Scope by domain, URL substring, URL regex and resource type
• Per-profile domain exclusions and a global never-modify list
• Credentials stored separately from profiles — session-only by default,
  or in a passphrase-encrypted vault (AES-GCM, PBKDF2 at 600,000 iterations)
• A credential-bearing profile must name where it applies, so a token
  cannot be attached to every request your browser makes
• Site access granted per domain, listed and revocable at any time
• Dark mode, import and export

VERIFIABLE BUILDS
The build is reproducible and every release carries a GitHub provenance
attestation. You can rebuild from source and confirm byte-for-byte that
the published extension matches. The bundle is not minified, so the
shipped code can be read. Instructions are in the README.

NO DATA COLLECTION
No analytics. No telemetry. No network requests of any kind — this is
enforced by a CI check that scans the built extension and fails the build
if any network primitive or remote resource appears in it.

Open source, MIT licensed.
```

### Privacy tab

| Field | Answer |
| --- | --- |
| Single purpose | Modifying HTTP request and response headers |
| Data collection | None |

Justifications, which the reviewer will ask for:

- **`declarativeNetRequest`** — the only mechanism used to modify headers. The
  extension never observes requests.
- **`storage`** — profiles and settings locally; credentials in session storage
  or encrypted.
- **`alarms`** — the credential vault's idle auto-lock timer.
- **`optional_host_permissions: ["*://*/*"]`** — nothing is granted at install.
  Access is requested per domain when a profile names one, so a user who scopes
  to `api.example.com` grants only that. Broad access is requested solely for
  profiles scoped by URL substring or regex, which genuinely can match any
  host, and only after telling the user so.

Answer **no** to every data-use question, and be ready to point at the source.

If the review flags host permissions anyway, the reply is that none are held at
install and the broad pattern is optional and user-initiated. Worth adding that
`activeTab` — which the reviewer's boilerplate suggests — cannot work for a
declarativeNetRequest extension: host access is needed when the request is
made, and `activeTab` grants it on a gesture that happens after the navigation
and is revoked by the next one. That was verified, not argued.

## Review

| | Typical wait |
| --- | --- |
| First submission | 3–7 business days |
| Update | 1–3 business days |
| Broad permissions | Often longer |

Common rejections and what fixes them:

| Reason | Fix |
| --- | --- |
| Broad host permissions flagged | Should no longer apply — nothing is requested at install. If it is raised anyway, answer that host access is optional and user-initiated, and that `activeTab` cannot work for a declarativeNetRequest extension (verified: host access is needed when the request is made; `activeTab` grants it on a gesture that happens after the navigation and is revoked by the next one) |
| Screenshots do not show functionality | Capture the profile editor with realistic rules |
| Single purpose unclear | Keep the description on header modification; do not lead with the security architecture |

## Updating

Bump the version, push the tag, download the new release artifact, upload it
in the dashboard, submit. The version in `manifest.json` comes from
`package.json`, so `npm version` is the only place it needs changing.

## After it is published

The extension gets a permanent ID and a store URL. Two things to do once:

1. Put the store link in `README.md`, replacing the "Not yet published" note in
   *Try it locally*.
2. Record the extension ID somewhere. Updates must go to the same listing;
   a new listing is a different extension to every existing user, and there is
   no way to migrate them.

Updates are reviewed faster than a first submission, but a change to the
permission set resets that — expect the longer review whenever
`scripts/permissions-baseline.json` changes.

## Distributing outside the store

For enterprise deployment you sign a `.crx` yourself:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension=/path/to/dist/chrome \
  --pack-extension-key=/path/to/key.pem
```

On the first run without `--pack-extension-key`, Chrome generates a `key.pem`
next to the `.crx`. **That file is the extension's permanent identity** — keep
it secret and back it up; losing it means every future build is a different
extension to Chrome. It is covered by `.gitignore`, and the secret scanner in
CI will catch it if it is ever committed.

Self-distributed `.crx` files are blocked on Windows and macOS unless deployed
through enterprise policy, so this path is for managed fleets, not public
distribution.
