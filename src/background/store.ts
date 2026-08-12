/* Reading and writing the configuration.
 *
 * The only place storage.local is touched for config, so migration runs in
 * exactly one place and everything downstream can assume a valid Config.
 */

import { migrate, needsMigration } from '../core/migrations';
import { defaultConfig, parseConfig, type Config } from '../core/schema';
import { local } from '../platform/chrome';

export const CONFIG_KEY = 'config';
/* Diagnostics the popup reads. Written by the worker, never read by it, so a
   write here must not retrigger a rule rebuild -- see the storage listener in
   the entrypoint. */
export const STATUS_KEY = 'status';

export async function loadConfig(): Promise<Config> {
  const raw = await local.get<unknown>(CONFIG_KEY);
  if (raw === undefined) return defaultConfig();
  return parseConfig(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  await local.set(CONFIG_KEY, config);
}

/* Runs migrations if the stored shape is behind, and persists the result.
 *
 * Writing back matters: without it every read would re-run the migration, and
 * a step that is expensive or lossy would run on every worker wake-up. The
 * write is skipped when nothing needed doing, which is the overwhelmingly
 * common case. */
export async function loadAndMigrate(): Promise<{ config: Config; migrated: readonly string[] }> {
  const raw = await local.get<unknown>(CONFIG_KEY);
  if (raw === undefined) {
    const config = defaultConfig();
    await saveConfig(config);
    return { config, migrated: [] };
  }

  if (!needsMigration(raw)) {
    return { config: parseConfig(raw), migrated: [] };
  }

  const result = migrate(raw);
  await saveConfig(result.config);
  return { config: result.config, migrated: result.applied };
}

export interface Status {
  /** Rules the engine refused, by header name only -- never a value. */
  ruleErrors: string[];
  /** Profiles whose credential half was withheld, and why. */
  blocked: { profileId: string; profileName: string; reasons: string[] }[];
  /** Operations dropped because Chrome would have rejected them. */
  problems: { profileId: string; header: string; detail: string }[];
  vaultUnlocked: boolean;
  /* Profiles configured to do something they currently lack host access for.
     Chrome enforces this itself by not applying the rule; this exists so the
     answer to "why is nothing happening" is on screen. */
  missingPermissions: {
    profileId: string;
    profileName: string;
    origins: string[];
    needsAllUrls: boolean;
    hasCredential: boolean;
  }[];
  budget: { dynamic: number; session: number; pressure: number; breaches: string[] };
  updatedAt: number;
}

export async function saveStatus(status: Status): Promise<void> {
  await local.set(STATUS_KEY, status);
}

export async function loadStatus(): Promise<Status | undefined> {
  return local.get<Status>(STATUS_KEY);
}
