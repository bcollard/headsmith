# Third-party notices and attribution

Headsmith is not a fork. Its feature set and its credential-security model were
taken from two existing extensions; its code, with one exception noted below,
was not. This file records what came from where in enough detail that a reader
can check the claim rather than take it on trust.

Both upstream projects are MIT licensed, which permits this and requires that
their copyright and permission notices be retained. Full licence texts are
reproduced at the end of this file.

---

## OpenModHeader

- **Upstream:** <https://github.com/Multivalence/OpenModHeader>
- **Copyright:** © 2026 Shiva M. **Licence:** MIT
- **Relationship:** Headsmith's *feature set and security model* were taken from
  OpenModHeader. Its code was not.

An earlier revision of this repository did contain close ports of several of its
modules. Those have been rewritten. The record is kept here rather than quietly
dropped, because the honest statement is not "no code was copied" but "code was
copied and then replaced", and the git history says so either way.

### What was taken

The design, which is genuinely OpenModHeader's and is worth crediting:

- storing credential-bearing header values outside the profile, under a
  reference, so a profile object never holds a secret;
- the two-tier storage idea — a session-only mode and a passphrase-encrypted
  vault whose key lives only in session storage;
- failing closed when a credential will not resolve, rather than sending an
  empty value;
- requiring a credential-bearing profile to name a host before it applies;
- grouping headers that share a condition into one declarativeNetRequest rule
  instead of emitting one rule per header per filter;
- retrying rule-by-rule after the engine rejects a batch, and reporting the
  offender by header name only.

### What is not shared

The implementations in `src/core/crypto/vault.ts`, `src/background/secrets.ts`,
`src/core/policy.ts`, `src/core/sensitivity.ts`, `src/core/plan.ts`,
`src/background/apply.ts` and `src/core/compile.ts` were written for this
project. Several differ deliberately, and where they do it is because the
rewrite was an opportunity to make a better choice rather than inherit one:

| Area | Difference |
| --- | --- |
| Vault records | Each record is sealed with its secret id as AES-GCM additional authenticated data, so a record moved between ids fails to decrypt. Without that binding, swapping two ciphertexts in the vault file yields a vault that decrypts perfectly and sends the wrong credential to the wrong host. |
| Vault parameters | KDF parameters live once on the vault rather than being duplicated onto every record, so the file cannot disagree with itself. The iteration count is bounded on both sides, so an imported vault cannot declare its own passphrase cheap to attack. |
| Host restriction | Decided by a positive test — does any literal text survive once the parts that match anything are stripped? — rather than by a list of wildcard spellings to reject. A blocklist is only as good as the imagination of whoever wrote it, and a credential is released on the strength of the answer. |
| Sensitivity detection | An ordered rule table where a match carries a *reason*, so the editor can explain why a header was flagged instead of only decorating it. |
| Planning | Each header is classified into exactly one outcome and the outcomes are partitioned afterwards, so "can a header be both emitted and reported missing?" is answered by the type rather than by reading a loop. |
| Batch recovery | A rejected batch is bisected rather than retried one rule at a time: one bad rule among 64 is found in about 14 engine calls instead of 64. |
| Storage modes | Two implementations of one store interface, rather than a mode conditional repeated in every function. |
| Credential modes | There is no persistent-plaintext mode. It is the only path by which a credential reaches disk unencrypted, and it would have required an exception in the plaintext-secret test. |
| Match model | A structure shaped like a declarativeNetRequest condition, with domain *inclusion* — which OpenModHeader lacks entirely, offering only domain exclusion. |
| URL exclusions | Global rather than per-profile, because a DNR `allow` rule outranks every lower-priority rule from every profile. OpenModHeader emits per-profile exclusions as bare `allow` rules, so one profile's exclusion silently suppresses the others on that URL. |
| Scope | Chrome only, so no blocking `webRequest` path exists. |
| Tests | OpenModHeader has none. |

---

## FlexHeader

- **Upstream:** <https://github.com/harrisondeo/FlexHeader>
- **Copyright:** © 2025 harrisondeo
- **Licence:** MIT
- **Relationship:** Headsmith takes its engineering approach — not its code —
  from FlexHeader, with one file derived directly.

| Headsmith file | Nature of the derivation |
| --- | --- |
| `test/fixtures/harness.ts` | The pattern of snapshotting compiled rule output to JSON and regenerating it behind an `UPDATE_FIXTURES` environment variable originates there; the kickoff for this project asked for it by name. Headsmith's version additionally records which rule bucket each rule landed in — the most security-relevant fact about the output — and the budget usage. |

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

## Written for this project

Everything not listed above, including: the four invariant guard scripts and the
JavaScript tokenizer inside the egress guard; `src/core/budget.ts`;
`src/core/schema.ts`; `src/core/migrations/`; `test/fakes/chrome.ts`; the
deterministic ZIP writer and the reproducible-build verifier; the GitHub Actions
workflows; the logo and its generator; the entire user interface; and the test
suite.

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
