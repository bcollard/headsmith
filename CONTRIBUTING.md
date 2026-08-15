# Contributing to Headsmith

## Getting set up

```bash
nvm use        # matches .nvmrc
npm ci
make check     # everything CI runs, in the same order
```

`make help` lists the rest.

To run it in a browser: `npm run build`, then load `dist/chrome` at
`chrome://extensions` with developer mode on. `make dev` gives you the same
thing with hot reload.

## The architecture in one rule

**`src/core` may not import `chrome`.**

```
src/core/        decides things      pure, no browser APIs, no I/O
src/platform/    touches the browser thin forwards to chrome.*
src/background/  wires them together
src/ui/          React
```

This is enforced twice — as a lint rule and as a CI guard that resolves import
paths, so a transitive reach through `src/platform` also fails. It is
load-bearing rather than stylistic: it is what lets the rule compiler be
snapshot-tested against JSON fixtures in milliseconds, and what makes "would
this profile release a credential?" a question answerable from a plain object.

If a function in `src/core` needs something from the browser, the caller
fetches it and passes it in.

## Tests

| | |
| --- | --- |
| `npm test` | unit tests |
| `npm run test:coverage` | with the thresholds CI enforces |
| `npm run test:e2e` | against a real Chrome with the extension loaded |
| `npm run test:update-fixtures` | regenerate rule snapshots — **review the diff** |

Coverage thresholds are set per directory, not globally, so UI churn cannot
quietly lower the bar on the compiler or the vault. `src/core` is held to 95%.

### The granted-host build

Host access is optional and requested from a user gesture, so a test cannot
grant it and Chrome's consent bubble cannot be driven. `npm run test:e2e`
therefore builds `dist/chrome-granted` as well, whose manifest declares
localhost outright, and the tests that need a rule to actually apply use that.

Everything up to the click -- no access at install, no effect without it, the
grant control appearing, the request refusing without a gesture -- runs against
the real build. If you add a test that needs headers to actually reach the
network, use `withGrantedHost`.

### Rule fixtures

`test/fixtures/rules/*.json` record the exact declarativeNetRequest rules the
compiler emits for a set of scenarios, including which bucket each rule lands
in. They exist because "did my refactor change what the browser gets?" is not
answerable by reading a diff of the compiler — a one-line change to condition
building can turn eight rules into ninety-six, or move a credential from the
session bucket to the disk-persisted one.

If you change rule generation deliberately, regenerate and **read the diff
before committing it**. The tests also assert properties directly, so a
regenerated fixture cannot enshrine a regression on its own.

## The invariant guards

Four scripts under `scripts/` fail CI on things no ordinary test would catch.
They run against `dist/`, not `src/`, because the bug they were modelled on —
a remote font stylesheet in a shipped extension — is invisible in a source tree.

| Guard | Fails when |
| --- | --- |
| `guard-egress.mjs` | any network primitive or off-origin subresource appears in the build |
| `guard-manifest.mjs` | the permission set drifts from its reviewed baseline |
| `guard-manifest-refs.mjs` | the manifest names a file that is not in the build |
| `guard-core-purity.mjs` | `src/core` reaches a browser API |

Run them with `npm run guard` after a build.

If a guard blocks you, the answer is almost never to widen its allowlist.
`scripts/egress-allowlist.json` is empty of hosts on purpose and every entry
requires a written reason, because an exception in that guard *is* the guard.
When Vite's modulepreload polyfill put a `fetch()` in the bundle, the fix was
to switch the polyfill off, not to excuse it.

## Changing permissions

Widening `permissions` or `host_permissions` requires three things in the same
pull request:

1. `scripts/permissions-baseline.json` updated, with a justification of at
   least a sentence for the new entry;
2. an entry in the `SECURITY.md` changelog;
3. the `permissions-change` label on the PR.

CI checks all three. Narrowing the set needs none of them.

## Commit and PR conventions

Explain **why**, not what — the diff already says what. If a change fixes
something subtle, say what would have gone wrong without it. Comments follow
the same rule: they earn their place by explaining a decision, a constraint, or
a trap, never by narrating the line below them.

## The project site

`docs/` is served at <https://bcollard.github.io/headsmith/> from `main`. Two
self-contained pages: no fonts, stylesheets, scripts or images come from
anywhere else, which is the same promise the extension makes and an odd one to
break on its own website. If you change the site, load it and confirm it still
makes no off-origin requests.

Screenshots there are copies from `assets/store/screenshots/`, so
`npm run screenshots` regenerates the source of truth and the copies in
`docs/img/` need refreshing alongside a UI change.

## Releasing

```bash
npm version minor          # or patch / major
git push --follow-tags
```

The tag triggers `release.yml`, which re-runs every gate, builds, packages a
deterministic zip, confirms it reproduces, generates a CycloneDX SBOM, attests
build provenance, and publishes.

Then upload the published `.zip` to the Chrome Web Store — see
[PUBLISHING.md](PUBLISHING.md). **Upload the artifact from the release, not a
locally built one**, or the attestation will not correspond to what users
install.

### Reproducibility

The build is a pure function of the source. If you touch the build or
packaging, check it still is:

```bash
node scripts/verify-reproducible.mjs --self
```

The one input outside the repository is the Node version, because `zlib` ships
with Node and deflate output is what the archive's bytes ultimately depend on.
That is why `.nvmrc` is pinned and used verbatim in CI, and why release notes
record the version used.

## Required repository settings

These live in repository configuration rather than in the tree, so they are
documented here. They are **applied** — this section records what is set and
why, not what someone ought to get round to.

On `main`:

- **Require a pull request before merging.** Approvals required: **0**, and
  that is deliberate rather than lax. GitHub does not let anyone approve their
  own pull request, so on a repository with one maintainer a requirement of one
  approval does not raise the bar — it makes merging impossible. Everything a
  review would gate on (the full test suite, the invariant guards, the security
  scans) is enforced by the required checks below, which no human can wave
  through. Raise this to 1 the moment there is a second maintainer.
- **Dismiss stale approvals** when new commits are pushed.
- **Require status checks to pass**, and require branches to be up to date
  first. Required checks:
  - `Typecheck, lint, test, build, guards`
  - `End-to-end against the real extension`
  - `Permission change needs review`
  - `CodeQL`, `Semgrep`, `Dependency vulnerabilities`, `Secret scan`
- **Require conversation resolution before merging.**
- **Require a linear history.**
- **Administrators may bypass the pull request and status-check requirements.**
  This is a deliberate concession to a single-maintainer repository, and it is
  the weakest setting here, so it is worth being exact about what it costs.

  A direct push to `main` by an administrator skips the seven required checks.
  They still *run* on the push, so a broken `main` is visible within a couple
  of minutes — but they no longer gate. Everyone else, including a future
  contributor and every Dependabot pull request, is held to all of them.

  What is deliberately **not** bypassable, for anyone: force pushes, branch
  deletion, unsigned commits, and the release-tag ruleset. Those are the
  settings that protect the history and the provenance chain rather than the
  quality of a change, and none of them has a convenience argument.
- **Restrict force pushes and deletions.**
- **Require signed commits.**

Also enable, under repository security settings: private vulnerability
reporting, Dependabot alerts and security updates, and secret scanning with
push protection.

Tag protection on `v*` matters more than it looks, and is applied as a
repository ruleset blocking deletion and non-fast-forward updates:
`release.yml` attests whatever a tag points at, so anyone able to move a tag
could obtain a signed attestation for content that was never reviewed. The
attestation would verify. That is the one place where the provenance story
could be undermined from inside the repository rather than outside it.

Tags are not required to be signed, because the release flow creates annotated
tags rather than signed ones. Worth revisiting; it is a smaller hole than a
movable tag, since the ruleset already prevents a tag from being repointed.
