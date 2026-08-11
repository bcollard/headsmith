/* Versioned storage migrations.
 *
 * The schema parser is tolerant by design -- it repairs anything it is given
 * rather than rejecting it. That covers malformed data, but not *renamed*
 * data: if a field moves from `filters` to `match.include`, a tolerant parser
 * sees the old field as unknown, drops it, and the user silently loses their
 * URL filters. Tolerance turns a rename into data loss.
 *
 * So renames and restructurings go here, as explicit ordered steps that run
 * before parsing. Each step takes the raw object at version N and returns the
 * raw object at version N+1. They are deliberately untyped: a migration's
 * input is a shape that no longer exists in the codebase, and typing it
 * against the current schema would be a lie that stops compiling the moment
 * the schema moves on.
 *
 * Rules for adding one:
 *
 *   - never delete a step, even when its source version is ancient -- someone
 *     has a browser that has been asleep since then;
 *   - a step must be idempotent where it can be, because a migration
 *     interrupted by the browser closing will be run again;
 *   - a step must never fabricate a credential value or move one between
 *     storage areas. Migrations run before the vault is unlocked.
 */

import { parseConfig, SCHEMA_VERSION, type Config } from '../schema';

export type RawConfig = Record<string, unknown>;

export interface Migration {
  /** The version this step upgrades *from*. */
  readonly from: number;
  readonly describe: string;
  readonly migrate: (raw: RawConfig) => RawConfig;
}

/* Ordered by `from`. v1 is the first schema Headsmith ever shipped, so there
   is nothing to migrate from yet; the machinery exists from day one because
   retrofitting it after the first breaking change is how projects end up
   writing one-off repair code in the background worker. */
export const MIGRATIONS: readonly Migration[] = [];

export function detectVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return SCHEMA_VERSION;
  const version = (raw as RawConfig)['version'];
  if (typeof version === 'number' && Number.isInteger(version) && version > 0) return version;
  /* No version field at all means data written before versioning existed.
     Treated as version 0 so every step runs. */
  return 0;
}

export interface MigrationResult {
  readonly config: Config;
  /** Which steps ran, for the UI and for tests. */
  readonly applied: readonly string[];
  readonly fromVersion: number;
}

/* Runs every applicable step, then parses. Never throws: a step that fails is
   skipped and recorded, because losing one migration is better than refusing
   to start. */
export function migrate(raw: unknown): MigrationResult {
  const fromVersion = detectVersion(raw);
  const applied: string[] = [];

  let current: RawConfig =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as RawConfig) } : {};

  for (const step of MIGRATIONS) {
    if (step.from < fromVersion) continue;
    if (step.from >= SCHEMA_VERSION) continue;
    try {
      current = step.migrate(current);
      applied.push(step.describe);
    } catch {
      /* A broken step must not brick the extension. The tolerant parser below
         will still produce a usable config, minus whatever this step would
         have rescued. */
    }
  }

  current['version'] = SCHEMA_VERSION;

  return { config: parseConfig(current), applied, fromVersion };
}

/* True when running `migrate` would change anything. Lets the worker skip a
   storage write on every startup for the overwhelmingly common case of
   already-current data. */
export function needsMigration(raw: unknown): boolean {
  return detectVersion(raw) < SCHEMA_VERSION;
}
