/* The Headsmith configuration schema.
 *
 * Two rules govern everything here:
 *
 *   1. Parsing never throws. Configuration comes from storage written by an
 *      older version, from an imported file, or from a user who edited JSON by
 *      hand. A schema that rejects the whole document because one field is the
 *      wrong type turns a bad row into a wiped profile list. Every field
 *      therefore carries a default and a `.catch()`, so a malformed value
 *      degrades to the default and the rest of the document survives.
 *
 *   2. A credential is never a field. A header marked sensitive carries a
 *      `secretId` pointing into the secret store and its `value` is forced
 *      empty on the way in. That is enforced here, at the parse boundary,
 *      rather than in the UI -- so a hand-edited config or an imported profile
 *      cannot smuggle a plaintext credential into storage.local by writing it
 *      into a field the editor would never have used.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/* The resource types Chrome's declarativeNetRequest accepts. Chrome rejects
   an entire rule if it sees a type it does not recognise, so this list is
   exactly Chrome's -- the extra types Firefox understands are deliberately
   absent, since there is no Firefox build. */
export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

/* Chrome only permits `append` on this set of request headers; anything else
   is rejected when the rule is submitted. Response headers have no such
   restriction. The editor checks against this so the user finds out while
   typing rather than from a rule the browser silently refused. */
export const APPENDABLE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
]);

export const PROFILE_COLORS = [
  '#b4470e',
  '#0d6e6b',
  '#3f3fbf',
  '#a81e1e',
  '#0b6e3f',
  '#6d28d9',
  '#0369a1',
  '#8a6212',
] as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const trimmedString = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().slice(0, max))
    .catch('');

const stringList = (max: number) =>
  z
    .array(z.unknown())
    .transform((items) =>
      items
        .filter((i): i is string => typeof i === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, max),
    )
    .catch([]);

export const headerOperationSchema = z.enum(['set', 'append', 'remove']).catch('set');
export type HeaderOperation = z.infer<typeof headerOperationSchema>;

export const credentialModeSchema = z.enum(['session', 'vault']).catch('session');
export type CredentialMode = z.infer<typeof credentialModeSchema>;

// ---------------------------------------------------------------------------
// Header operations
// ---------------------------------------------------------------------------

export const headerOpSchema = z
  .object({
    id: z.string().min(1).catch(() => newId()),
    enabled: z.boolean().catch(true),
    operation: headerOperationSchema,
    name: trimmedString(256),
    value: z.string().max(8192).catch(''),
    comment: trimmedString(500),
    /* Sticky: once a header is known to carry a credential it stays that way.
       Detection happens in sensitivity.ts and can only ever add to this. */
    sensitive: z.boolean().catch(false),
    secretId: z.string().min(1).nullable().catch(null),
  })
  .transform((h) => ({
    ...h,
    /* Rule 2 above, enforced at the boundary: a header that references a
       secret holds no inline value, whatever the input claimed. */
    value: h.secretId ? '' : h.value,
  }));

export type HeaderOp = z.infer<typeof headerOpSchema>;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/* The match set mirrors a declarativeNetRequest condition rather than being a
   flat list of typed filter rows, which is how both reference projects model
   it. Two reasons:

   - it makes the compiler close to mechanical, and
   - it makes cost visible. `domains` compiles to `requestDomains`, which is
     free; `urlRegex` compiles to `regexFilter`, and there is a hard ceiling of
     1000 regex rules per rule set. A model that hides that distinction
     encourages the expensive option. */
export const matchSetSchema = z
  .object({
    include: z
      .object({
        domains: stringList(200),
        urlContains: stringList(200),
        urlRegex: stringList(100),
      })
      .catch({ domains: [], urlContains: [], urlRegex: [] }),
    exclude: z
      .object({
        /* Domain exclusion is the only exclusion expressible inside a single
           condition (`excludedRequestDomains`), which is what makes it
           genuinely per-profile. URL-based exclusion needs an `allow` rule,
           and an `allow` rule outranks every profile's rules rather than just
           this one -- so it lives at config level, not here. */
        domains: stringList(200),
      })
      .catch({ domains: [] }),
    resourceTypes: z
      .array(z.enum(RESOURCE_TYPES))
      .transform((types) => [...new Set(types)])
      .catch([]),
  })
  .catch({
    include: { domains: [], urlContains: [], urlRegex: [] },
    exclude: { domains: [] },
    resourceTypes: [],
  });

export type MatchSet = z.infer<typeof matchSetSchema>;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const profileSchema = z.object({
  id: z.string().min(1).catch(() => newId()),
  name: trimmedString(60),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .catch(PROFILE_COLORS[0]),
  enabled: z.boolean().catch(true),
  /* Per-profile escape hatch from the "credentials need a host restriction"
     rule. Deliberately per profile rather than global: accepting the risk once
     for a local development profile should not disable the protection for the
     profile that carries a production token. */
  allowGlobalSensitive: z.boolean().catch(false),
  match: matchSetSchema,
  requestHeaders: z.array(headerOpSchema).catch([]),
  responseHeaders: z.array(headerOpSchema).catch([]),
});

export type Profile = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsSchema = z
  .object({
    /* Session by default: nothing touches disk, and the cost is retyping a
       credential after a browser restart. There is deliberately no
       persistent-plaintext mode. */
    credentialStorage: credentialModeSchema,

    /* A profile carrying a credential must be scoped to some host, so that a
       token meant for one API is not attached to every request the browser
       makes. */
    requireExplicitHosts: z.boolean().catch(true),
    warnOnInsecureHosts: z.boolean().catch(true),

    lockAfterMinutes: z.number().int().min(1).max(1440).catch(15),
    disableAutoLock: z.boolean().catch(false),

    omitCredentialsByDefault: z.boolean().catch(true),
  })
  .catch({
    credentialStorage: 'session',
    requireExplicitHosts: true,
    warnOnInsecureHosts: true,
    lockAfterMinutes: 15,
    disableAutoLock: false,
    omitCredentialsByDefault: true,
  });

export type Settings = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const secretMetaSchema = z.object({
  /* Metadata only. A label and a timestamp, never a value -- this object is in
     storage.local, which is exactly where a credential must not be. */
  label: trimmedString(80),
  createdAt: z.number().int().nonnegative().catch(0),
});

export type SecretMeta = z.infer<typeof secretMetaSchema>;

export const configSchema = z.object({
  version: z.literal(SCHEMA_VERSION).catch(SCHEMA_VERSION),
  paused: z.boolean().catch(false),
  activeProfileId: z.string().catch(''),
  settings: settingsSchema,
  profiles: z.array(profileSchema).catch([]),
  /* Global "never modify these URLs". Compiled to top-priority `allow` rules.
     Global rather than per-profile because a DNR `allow` rule suppresses every
     lower-priority rule from every profile, so a per-profile exclusion would
     silently disable other profiles and there would be no honest way to
     label it. */
  exclusions: z
    .object({
      urlContains: stringList(200),
      urlRegex: stringList(100),
    })
    .catch({ urlContains: [], urlRegex: [] }),
  secretsMeta: z.record(z.string(), secretMetaSchema).catch({}),
});

export type Config = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/* Ids only need to be unique within one config, not globally, and they are
   never a security boundary -- nothing is authorised by knowing one. */
let idCounter = 0;
export function newId(): string {
  idCounter = (idCounter + 1) % 0xffff;
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(3, '0')}`;
}

export function newSecretId(): string {
  return `secret-${newId()}`;
}

export function blankHeaderOp(overrides: Partial<HeaderOp> = {}): HeaderOp {
  return {
    id: newId(),
    enabled: true,
    operation: 'set',
    name: '',
    value: '',
    comment: '',
    sensitive: false,
    secretId: null,
    ...overrides,
  };
}

export function blankMatchSet(): MatchSet {
  return {
    include: { domains: [], urlContains: [], urlRegex: [] },
    exclude: { domains: [] },
    resourceTypes: [],
  };
}

export function blankProfile(index = 1): Profile {
  return {
    id: newId(),
    name: `Profile ${index}`,
    color: PROFILE_COLORS[(index - 1) % PROFILE_COLORS.length]!,
    enabled: true,
    allowGlobalSensitive: false,
    match: blankMatchSet(),
    requestHeaders: [blankHeaderOp()],
    responseHeaders: [],
  };
}

export function defaultConfig(): Config {
  const profile = blankProfile(1);
  return {
    version: SCHEMA_VERSION,
    paused: false,
    activeProfileId: profile.id,
    settings: settingsSchema.parse({}),
    profiles: [profile],
    exclusions: { urlContains: [], urlRegex: [] },
    secretsMeta: {},
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/* Turns anything at all into a valid Config. Never throws.
 *
 * `.catch()` on every field means zod itself will not reject the document, but
 * a few cross-field guarantees cannot be expressed per-field and are repaired
 * here instead. */
export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  const config: Config = result.success ? result.data : defaultConfig();

  /* An empty profile list is a config that can do nothing and that the UI
     cannot render, so it becomes a fresh default rather than an empty shell. */
  if (config.profiles.length === 0) {
    config.profiles = [blankProfile(1)];
  }

  /* activeProfileId must name a profile that exists, or the popup opens on
     nothing. */
  if (!config.profiles.some((p) => p.id === config.activeProfileId)) {
    config.activeProfileId = config.profiles[0]!.id;
  }

  /* Profile ids must be unique: two profiles sharing an id makes "edit this
     profile" ambiguous and can make a delete remove the wrong one. */
  const seen = new Set<string>();
  for (const profile of config.profiles) {
    if (seen.has(profile.id)) profile.id = newId();
    seen.add(profile.id);
  }

  /* Metadata for a secret no profile references any more is dropped, and
     every referenced secret gets a metadata row. Keeps the two in step so
     orphan pruning has something to work from. */
  const referenced = collectSecretIds(config);
  const meta: Record<string, SecretMeta> = {};
  for (const id of referenced) {
    meta[id] = config.secretsMeta[id] ?? { label: '', createdAt: 0 };
  }
  config.secretsMeta = meta;

  return config;
}

/* Every secret id any profile refers to. Used for orphan pruning, and to
   decide whether deleting a profile may delete the secret it points at -- a
   secret can be shared between profiles. */
export function collectSecretIds(config: Pick<Config, 'profiles'>): string[] {
  const ids = new Set<string>();
  for (const profile of config.profiles) {
    for (const list of [profile.requestHeaders, profile.responseHeaders]) {
      for (const header of list) {
        if (header.secretId) ids.add(header.secretId);
      }
    }
  }
  return [...ids];
}

export function secretRefCount(config: Pick<Config, 'profiles'>, secretId: string): number {
  let count = 0;
  for (const profile of config.profiles) {
    for (const list of [profile.requestHeaders, profile.responseHeaders]) {
      for (const header of list) {
        if (header.secretId === secretId) count++;
      }
    }
  }
  return count;
}
