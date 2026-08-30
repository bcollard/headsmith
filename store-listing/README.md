# Store listing copy

The text pasted into the Chrome Web Store dashboard, kept here so it is
reviewable and diffable rather than living only in a web form nobody can see
the history of.

| Field | Where it comes from |
| --- | --- |
| Name | `src/public/_locales/<locale>/messages.json` → `extName`. Automatic; read-only in the dashboard. |
| Summary | same file → `extDescription`. Automatic. |
| Detailed description | `store-listing/<locale>.md` — **pasted by hand**, per language |
| Screenshots | `assets/store/screenshots/` — uploaded per language; the same files are fine |

Category, promo tiles, website and support URLs are global — set once.

**Upload the package before editing any listing text.** The language selector
only offers languages the *uploaded package* declares under `_locales/`, so
editing first means the tabs are not there yet.

## Copy rules these files follow

- No superlatives, no generic praise.
- No term repeated across name, summary and description — that is keyword spam,
  which is grounds for suspension rather than merely rejection. The name already
  carries "HTTP Header Editor", so the body says "modify headers" and
  "request headers" instead of repeating it.
- **No sentence has another extension as its subject**, named or not. Claims
  about what other software does are unsubstantiable and read as disparagement.
  The same points are made about this extension and the platform instead.
- Opens with what it does, not with how it is built. "Single purpose not clear"
  is a documented rejection reason and leading with architecture invites it.
