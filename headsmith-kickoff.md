# Headsmith — kickoff prompt

> Paste everything below the line into a fresh Claude Code session, in the empty
> directory where you want the project to live.

---

We're building **Headsmith**, a Chrome extension for adding, rewriting, and removing
HTTP request/response headers — organised into profiles and scoped by URL filters.

It is a deliberate synthesis of two existing open-source extensions that both live on
this machine. **Read them before writing any code.** They are reference material, not
dependencies — we are not forking either one.

## Reference implementations

**A. OpenModHeader** — `/Users/baptiste.collard@konghq.com/projects/public/Multivalence/OpenModHeader`

Take the **feature set and the security model** from here. It is ~5k lines of dependency-free
vanilla JS across `chromium/` and `firefox/`. Read `chromium/*.js` and `SECURITY.md`.

What is genuinely good and should be carried over:

- **The rule model.** Request + response headers with set/append/remove; cookie editing with
  merge/replace modes; CSP directive editing; redirects including regex substitution; filters
  by domain, url-contains, url-regex, each with exclude variants, plus resource types, tab IDs
  and window IDs. This is a much richer model than most header extensions ship.
- **The credential vault** (`vault.js`, `secretstore.js`). PBKDF2-derived AES-GCM key; the key
  lives in `storage.session` only and is dropped on lock; ciphertext in `storage.local`;
  auto-lock via `alarms`. Header *values* marked sensitive are never written in plaintext.
- **Fail-closed credential handling.** When the vault is locked or a secret won't resolve,
  only the credential-bearing operation is skipped — the rest of the profile still applies,
  and an empty value is never sent in place of a secret. See `planProfile` and the
  `compileProfile` "keep" logic.
- **Security-aware UX.** Sensitive-header detection, warnings when credentials target plain
  `http://` hosts, re-authentication prompts before clipboard copies, and export modes that
  omit credentials by default (config / encrypted backup / full).
- **Rule bucketing.** The background worker groups headers that share a condition into one
  declarativeNetRequest rule instead of emitting one rule per header per filter. Keep this —
  see the DNR rule-count constraint below.

What is wrong with it and must NOT be carried over:

- **~4,900 lines are duplicated byte-for-byte** between `chromium/` and `firefox/`. Only
  `background.js` genuinely differs. Every fix has to land twice. We are Chrome-only, so this
  is moot, but the lesson stands: one source of truth.
- **Zero tests. Zero CI.** No `package.json`, no build step, no typechecking.

**B. FlexHeader** — `/Users/baptiste.collard@konghq.com/projects/public/harrisondeo/FlexHeader`

Take the **engineering approach** from here. Read `package.json`, `wxt.config.ts`,
`vitest.config.ts`, `playwright.config.ts`, `src/background/`, `src/utils/storage/`, and
`CLAUDE.md`.

What to adopt:

- **WXT + Vite + TypeScript + React**, strict mode, `tsc --noEmit` in CI.
- **Vitest for unit tests, Playwright for e2e** against a real loaded extension. Note how
  `pretest:e2e` builds first, and how `src/background/__fixtures__/rules/` snapshots the
  compiled DNR rule output — that fixture pattern is the single best idea in this repo and we
  want it from day one, because "did my refactor change the emitted rules?" is exactly the
  question that matters.
- **Pure, testable rule construction.** `src/background/rules.ts` is deliberately separated
  from `background.ts` so it can be unit tested without a browser. Do this.
- **Zod-validated storage schemas + explicit versioned migrations** (`src/utils/migrations/`).
- **Sensible extras:** drag-and-drop reordering, dark mode, import/export, an error-reporting
  surface, `CONTRIBUTING.md`.

What to fix, not copy:

- **It leaks to Google Fonts.** `src/entrypoints/app/index.html` loads a remote stylesheet from
  `fonts.googleapis.com`, and this is present in the shipped `builds/v1.9.6.zip`. MV3's default
  CSP doesn't restrict `style-src`/`font-src`, so it loads — handing Google your IP, UA and
  usage timing on every popup open, while the store listing claims "no data collection."
  **Headsmith ships zero remote subresources.** Self-host or use a system font stack.
- **Its sync is plaintext.** Opt-in `storage.sync` uploads header values — including any
  `Authorization` tokens — to Google's sync servers unencrypted. There is no crypto anywhere
  in the codebase.
- **No CI at all.** It owns 29 test files and a Playwright suite that nothing runs
  automatically, while merging external PRs and 19 AI-agent commits into an `<all_urls>`
  extension. Dependabot ran five times in 2024 and has been dead since; a workflow file was
  added and then deliberately deleted (commit `79a648c`).

## Scope

**Chrome only.** Manifest V3, `declarativeNetRequest`. No Firefox target, no
`browser_specific_settings`, no `webRequest`/`webRequestBlocking`, and no
`webextension-polyfill` — use `chrome.*` promise APIs directly and keep the dependency count
near zero.

This is a security win worth stating explicitly in the README: a DNR-only extension **cannot
observe your traffic at all.** It hands declarative rules to the browser and never sees a
request. OpenModHeader's Firefox build uses blocking `webRequest` and therefore does see every
header on every site.

### DNR consequences you must design around

Do not assume OpenModHeader's feature list ports over unchanged. DNR cannot *read* an existing
header value, which constrains three features. Verify each against current Chrome documentation
before committing to a design:

- **Cookie merge.** True merge ("overwrite the same-name cookie, keep the others") requires
  reading the outgoing `Cookie` header, which DNR cannot do. `append` on `Cookie` gets you
  additive semantics and `set` gets you replace. Ship those two, name them honestly in the UI,
  and document the limitation rather than pretending.
- **CSP directive editing.** Same problem — you can only construct and `set` a whole CSP value,
  not surgically merge directives into whatever the site sent.
- **Rule-count budget.** Dynamic + session rules are capped (~5,000; confirm the current value).
  A naive one-rule-per-header-per-filter expansion — which is what FlexHeader does — blows up
  fast. Port OpenModHeader's condition-bucketing compiler and add a test that asserts the rule
  count for a large realistic profile stays well under budget.
- `tabIds` conditions are only valid on **session-scoped** rules. Plan the dynamic/session split
  around that.

## Non-negotiable invariants

These are the product's reason to exist. Encode each one as an automated check, not a comment.

1. **No network egress, ever.** No `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`,
   `EventSource`, no analytics, no `setUninstallURL`, no native messaging.
2. **No remote subresources.** No CDN scripts, styles, fonts or images in any extension page.
3. **No plaintext secrets at rest.** Anything marked sensitive is AES-GCM encrypted with a key
   held only in `storage.session`.
4. **`storage.sync` never receives a secret.** Either omit sync entirely for v1, or sync only
   non-sensitive config and be loud in the UI about what crosses the device boundary.
5. **No dynamic code execution.** No `eval`, no `new Function`, no string `setTimeout`.
6. **Least permission.** `storage`, `declarativeNetRequest`, `alarms` and whatever is strictly
   required. Justify every entry in the manifest in a comment. `<all_urls>` needs a written
   rationale in `SECURITY.md`.

## GitHub Actions security gates

This is where both reference projects fail completely, and it's the main thing we're adding.
Set up `.github/workflows/` with genuine gates, not decoration:

**Correctness, on every PR:** `tsc --noEmit`, lint, `vitest run` with coverage thresholds, and
Playwright e2e against the built extension. Fail the build, don't just warn.

**Custom invariant guards — these matter more than any off-the-shelf scanner**, because they are
the gates that would have caught the real bug in FlexHeader:

- **Egress guard.** Grep the *built bundle and every built HTML file* for network primitives and
  for any external hostname; allowlist the handful of build-tool artifacts (Vite's modulepreload
  polyfill legitimately calls `fetch` on local chunks) and fail on anything else. Assert against
  build output, not source — the Google Fonts tag only becomes visible in `dist/`.
- **Manifest permission diff guard.** Fail CI when `permissions` or `host_permissions` change
  unless the PR carries an explicit approval label and a `SECURITY.md` changelog entry.
- **Plaintext-secret guard.** A test that writes a sensitive header, dumps the fake
  `storage.local`, and asserts the cleartext value does not appear anywhere in it.

**Supply chain:**

- `dependabot.yml` covering both the `npm` **and** `github-actions` ecosystems, grouped, weekly.
- Dependency vulnerability scan (`osv-scanner` or equivalent) blocking on High/Critical.
- **Pin every action to a full commit SHA**, never a floating tag.
- Default `permissions: {}` at workflow level, with least-privilege grants per job.
- `step-security/harden-runner` in egress-audit mode — fitting, given the whole product promise
  is "no egress."
- CycloneDX SBOM as a build artifact.

**Static analysis:** CodeQL (`javascript-typescript`) plus Semgrep (`p/javascript`,
`p/owasp-top-ten`) — with the honest expectation that these will mostly be quiet on a codebase
this size, and that the custom guards above are doing the real work.

**Secret scanning:** gitleaks or trufflehog on PRs and on a schedule.

**Release integrity — please solve this properly.** Both reference extensions share an
unresolvable trust gap: you cannot verify that the artifact published to the Web Store was built
from the public source. FlexHeader is especially bad here, since verification means diffing a
439KB minified chunk. For Headsmith: make the build reproducible, publish the artifact with
GitHub attestations / provenance, and put a short "verify the build yourself" section in the
README with the exact commands. This is a real differentiator, and it's cheap.

Also document the required branch-protection settings in `CONTRIBUTING.md`, since those live in
repo config rather than in the tree.

## How to proceed

1. Read both reference projects first. Confirm or correct the claims I've made above — they come
   from an audit of these repos, but verify rather than trust, especially the DNR constraints.
2. **Present a plan before implementing.** I want to see the proposed rule/profile data model,
   the dynamic-vs-session rule split, the vault design, the module layout, and the workflow
   inventory. Flag anything from OpenModHeader's feature list that DNR makes infeasible so we
   can decide together whether to cut it or reshape it.
3. Then build in vertical slices, each landing with tests: storage + schema + migrations →
   rule compiler with snapshot fixtures → background worker → vault → UI → CI workflows.
4. Set up the CI workflows and the custom guards **early**, while the codebase is small enough
   that getting them green is trivial.
5. Write `CLAUDE.md` as you go, capturing decisions and their rationale — FlexHeader's is a good
   model for what belongs in it.

Start by reading the two reference projects and giving me the plan.
