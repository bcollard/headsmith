# Third-party notices and attribution

Headsmith is not a fork, but a significant part of it is derived work. This
file records what came from where, in enough detail that a reader can check
the claim rather than take it on trust.

Both upstream projects are MIT licensed, which permits this and requires that
their copyright and permission notices be retained. Full licence texts are
reproduced at the end of this file.

---

## OpenModHeader

- **Upstream:** <https://github.com/Multivalence/OpenModHeader>
- **Copyright:** © 2026 Shiva M
- **Licence:** MIT
- **Relationship:** Headsmith's credential-security model is a TypeScript port
  of OpenModHeader's, with modifications. This is the substantial derivation.

The kickoff for this project set out to take OpenModHeader's feature set and
security model, and that is what happened. The following files are derived
work, listed most-derived first:

| Headsmith file | Derived from | Nature of the derivation |
| --- | --- | --- |
| `src/core/crypto/vault.ts` | `chromium/vault.js` | Close port. Same function set and signatures, same KDF and cipher parameters (PBKDF2-SHA256 at 600,000 iterations, 16-byte salt, AES-GCM with 12-byte IV and 128-bit tag), same check-sentinel design for passphrase verification, same null-on-authentication-failure contract, same carry-corrupt-records-forward behaviour when rotating a passphrase. |
| `src/background/secrets.ts` | `chromium/secretstore.js` | Close port. Same storage-area split, same public surface, same auto-lock design in which the deadline is a timestamp in session storage and the alarm only wakes the worker to re-check it. |
| `src/core/policy.ts` | `chromium/security.js` | Derived. The activation-gate concept, the verdict object's shape, the wildcard-rejection regular expression and the loopback exemption list all originate there. |
| `src/core/sensitivity.ts` | `chromium/security.js` | Derived. The sensitive-header name list and pattern list originate there, as does the rule that a user's flag may add sensitivity but never remove it. |
| `src/core/plan.ts` | `chromium/common.js` (`planProfile`) | Derived. The fail-closed credential-resolution structure originates there. |
| `src/background/apply.ts` | `chromium/background.js` | Derived. The per-rule retry after a batch rejection, the in-flight/queued serialisation, the profile-provenance annotation stripped before submission, and the header-names-only error strings all originate there. |
| `src/core/compile.ts` | `chromium/background.js` (`buildRules`) | Partly derived. The condition-bucketing approach and the emit/strip structure originate there; the match model it compiles from is a redesign (see below). |

### What Headsmith changed

Recorded for honesty in both directions — these are the parts that are not
OpenModHeader's:

- **No persistent-plaintext credential mode.** OpenModHeader offers one. It is
  the only path by which a credential reaches disk unencrypted, and its
  presence would have made the plaintext-secret test unwritable without an
  exception.
- **Match model.** OpenModHeader uses a flat list of typed filter rows.
  Headsmith uses a structure shaped like a `declarativeNetRequest` condition,
  and adds domain *inclusion* (`requestDomains`), which OpenModHeader lacks
  entirely — it offers only domain exclusion.
- **URL exclusions are global, not per-profile.** A DNR `allow` rule outranks
  every lower-priority rule from every profile. OpenModHeader emits per-profile
  URL exclusions as bare `allow` rules, so one profile's exclusion silently
  suppresses other profiles on that URL.
- **Unlock throttling.** OpenModHeader has none.
- **A raised minimum iteration count** when validating an imported vault, so a
  hostile vault cannot declare its own passphrase cheap to attack.
- **Rule-budget accounting** (`src/core/budget.ts`) — no counterpart upstream.
- **Chrome only**, and therefore no blocking `webRequest` path.
- **Tests.** OpenModHeader has none; the derived files here are covered by the
  suite in this repository.

---

## FlexHeader

- **Upstream:** <https://github.com/harrisondeo/FlexHeader>
- **Copyright:** © 2025 harrisondeo
- **Licence:** MIT
- **Relationship:** Headsmith takes its engineering approach — not its code —
  from FlexHeader, with one file derived directly.

| Headsmith file | Derived from | Nature of the derivation |
| --- | --- | --- |
| `test/fixtures/harness.ts` | `src/background/__fixtures__/fixtureHelpers.ts` | Derived. The pattern of snapshotting compiled rule output to JSON and regenerating it behind an `UPDATE_FIXTURES` environment variable originates there. Headsmith's version additionally records which rule bucket each rule landed in, and the budget usage. |

Beyond that single file, the influence is structural rather than textual: WXT +
Vite + TypeScript + React with strict mode, Vitest for unit tests and Playwright
against a real loaded extension, Zod-validated storage schemas with versioned
migrations, and building before the end-to-end suite runs.

### What Headsmith changed

- **No remote subresources.** FlexHeader's shipped build loads a stylesheet
  from `fonts.googleapis.com`. Headsmith uses a system font stack, and CI fails
  the build if any remote subresource appears in the output.
- **No plaintext sync.** FlexHeader's optional `storage.sync` uploads header
  values, including credentials, unencrypted. Headsmith has no `storage.sync`
  code path at all.
- **Rules are bucketed by condition** rather than emitted one per header per
  filter.
- **CI exists.** FlexHeader has no workflows.

---

## Advanced Bookmarks

- **Upstream:** a private project in this workspace, same author as Headsmith.
- **Relationship:** `scripts/guard-manifest-refs.mjs` is a Node port of its
  `scripts/validate.py`, extended to run against build output. The idea of
  generating icons from a dependency-free encoder rather than committing binary
  assets also comes from there, though the implementation is new. Its
  `PUBLISHING.md` informed this project's release documentation.

---

## Not derived

For completeness, the parts of Headsmith with no upstream counterpart: the four
invariant guard scripts (except `guard-manifest-refs.mjs` as noted above) and
the JavaScript tokenizer inside the egress guard; `src/core/budget.ts`;
`test/fakes/chrome.ts`; `src/core/schema.ts`'s never-throws parsing discipline
and parse-boundary credential stripping; `src/core/migrations/index.ts`; the
GitHub Actions workflows; the logo and its generator; and the test suite.

---

## Licence texts

### OpenModHeader

```
MIT License

Copyright (c) 2026 Shiva M

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### FlexHeader

```
MIT License

Copyright (c) 2025 harrisondeo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
