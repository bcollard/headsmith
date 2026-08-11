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

All generated — run `npm run icons` and they land in `assets/`.

| Asset | Size | Where |
| --- | --- | --- |
| Extension icons | 16 / 32 / 48 / 128 | `src/public/icons/`, bundled automatically |
| Store icon | 128 × 128 | `assets/store/store-icon-128.png` |
| Small promo tile | 440 × 280 | `assets/store/promo-small-440x280.png` |
| Marquee promo tile | 1400 × 560 | `assets/store/promo-marquee-1400x560.png` |
| Screenshots | 1280 × 800 (or 640 × 400) | You supply these — at least one, up to five |

Screenshots are the one thing not generated. Take them at exactly 1280 × 800:
open the extension page, then DevTools → device toolbar → set 1280 × 800 →
capture screenshot. Show the profile editor with real-looking rules; the most
common rejection is screenshots that do not demonstrate the described
functionality.

## Release and upload

```bash
npm version minor
git push --follow-tags
```

Wait for `release.yml` to finish, then download the `.zip` **from the GitHub
release page**.

Sanity-check it before uploading:

```bash
gh attestation verify headsmith-1.0.0.zip --repo bcollard/headsmith
node scripts/verify-reproducible.mjs headsmith-1.0.0.zip
```

Then: developer console → **New item** → upload the zip. Chrome parses the
manifest and reports validation errors before you go further.

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

FEATURES
• Set, append and remove request and response headers
• Profiles you can switch between, enable individually, or pause entirely
• Scope by domain, URL substring, URL regex and resource type
• Per-profile domain exclusions and a global never-modify list
• Credentials stored separately from profiles — session-only by default,
  or in a passphrase-encrypted vault (AES-GCM, PBKDF2 at 600,000 iterations)
• A credential-bearing profile must name where it applies, so a token
  cannot be attached to every request your browser makes
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
- **`<all_urls>`** — users configure which hosts their header rules apply to at
  runtime, so the host set cannot be known at install time. The permission
  allows modifying headers, not reading traffic, which declarativeNetRequest
  does not permit.

Answer **no** to every data-use question, and be ready to point at the source.
A header extension requesting `<all_urls>` attracts scrutiny; the honest
answer — that DNR structurally cannot read traffic — is also the persuasive
one.

## Review

| | Typical wait |
| --- | --- |
| First submission | 3–7 business days |
| Update | 1–3 business days |
| Broad permissions | Often longer |

Common rejections and what fixes them:

| Reason | Fix |
| --- | --- |
| Permissions not justified | Restate the `<all_urls>` argument in the listing itself, not only in the repo |
| Screenshots do not show functionality | Capture the profile editor with realistic rules |
| Single purpose unclear | Keep the description on header modification; do not lead with the security architecture |

## Updating

Bump the version, push the tag, download the new release artifact, upload it
in the dashboard, submit. The version in `manifest.json` comes from
`package.json`, so `npm version` is the only place it needs changing.

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
