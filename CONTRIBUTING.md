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
documented here. On `main`:

- **Require a pull request before merging**, with at least one approving review
  and stale approvals dismissed on new commits.
- **Require status checks to pass**, and require branches to be up to date
  first. Required checks:
  - `Typecheck, lint, test, build, guards`
  - `End-to-end against the real extension`
  - `Permission change needs review`
  - `CodeQL`, `Semgrep`, `Dependency vulnerabilities`, `Secret scan`
- **Require conversation resolution before merging.**
- **Do not allow bypassing the above**, including for administrators. An
  extension with `<all_urls>` is not a place for a convenience exemption.
- **Restrict force pushes and deletions.**
- **Require signed commits.**

Also enable, under repository security settings: private vulnerability
reporting, Dependabot alerts and security updates, and secret scanning with
push protection.

Tag protection on `v*` matters more than it looks: `release.yml` attests
whatever a tag points at, so anyone who can move a tag can get a signed
attestation for arbitrary content.
