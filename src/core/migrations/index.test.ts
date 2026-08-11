import { describe, it, expect } from 'vitest';
import { migrate, needsMigration, detectVersion, MIGRATIONS, type Migration } from './index';
import { SCHEMA_VERSION } from '../schema';

describe('detectVersion', () => {
  it('reads an explicit version', () => {
    expect(detectVersion({ version: 1 })).toBe(1);
  });

  it('treats data with no version as pre-versioning', () => {
    // Version 0 means "before we numbered anything", so every step runs.
    expect(detectVersion({ profiles: [] })).toBe(0);
  });

  it('treats a nonsense version as pre-versioning rather than trusting it', () => {
    expect(detectVersion({ version: 'three' })).toBe(0);
    expect(detectVersion({ version: -1 })).toBe(0);
    expect(detectVersion({ version: 1.5 })).toBe(0);
  });

  it('leaves non-objects alone', () => {
    expect(detectVersion(null)).toBe(SCHEMA_VERSION);
    expect(detectVersion('nope')).toBe(SCHEMA_VERSION);
  });
});

describe('needsMigration', () => {
  it('is false for current data', () => {
    expect(needsMigration({ version: SCHEMA_VERSION })).toBe(false);
  });

  it('is true for unversioned data', () => {
    expect(needsMigration({ profiles: [] })).toBe(true);
  });
});

describe('migrate', () => {
  it('stamps the current version on whatever it is given', () => {
    expect(migrate({}).config.version).toBe(SCHEMA_VERSION);
  });

  it('produces a usable config from nothing at all', () => {
    for (const input of [null, undefined, 42, 'text', []]) {
      const { config } = migrate(input);
      expect(config.profiles.length).toBeGreaterThan(0);
    }
  });

  it('reports which version it started from', () => {
    expect(migrate({ profiles: [] }).fromVersion).toBe(0);
  });

  it('applies no steps when there are none to apply', () => {
    expect(migrate({ version: SCHEMA_VERSION }).applied).toEqual([]);
  });

  it('does not mutate the input object', () => {
    // Migrations run against data read from storage; mutating it in place
    // makes a failed write leave a half-migrated object in memory.
    const raw = { version: 0, profiles: [] };
    migrate(raw);
    expect(raw.version).toBe(0);
  });

  it('preserves data a step does not touch', () => {
    const { config } = migrate({
      version: 0,
      paused: true,
      profiles: [{ id: 'keep', name: 'Kept' }],
    });
    expect(config.paused).toBe(true);
    expect(config.profiles[0]!.name).toBe('Kept');
  });
});

describe('a failing migration step', () => {
  /* Exercised against a synthetic registry rather than the real one, which is
     empty at v1. The behaviour under test is that one broken step degrades
     that step alone -- losing one migration is recoverable, refusing to start
     is not. */
  function runWith(steps: Migration[], raw: unknown) {
    const original = [...MIGRATIONS];
    try {
      (MIGRATIONS as unknown as Migration[]).length = 0;
      (MIGRATIONS as unknown as Migration[]).push(...steps);
      return migrate(raw);
    } finally {
      (MIGRATIONS as unknown as Migration[]).length = 0;
      (MIGRATIONS as unknown as Migration[]).push(...original);
    }
  }

  it('is skipped without taking the rest of the config down', () => {
    const result = runWith(
      [
        {
          from: 0,
          describe: 'explodes',
          migrate: () => {
            throw new Error('boom');
          },
        },
      ],
      { version: 0, paused: true, profiles: [{ id: 'p', name: 'Survivor' }] },
    );

    expect(result.applied).toEqual([]);
    expect(result.config.profiles[0]!.name).toBe('Survivor');
  });

  it('does not stop later steps from running', () => {
    const result = runWith(
      [
        {
          from: 0,
          describe: 'explodes',
          migrate: () => {
            throw new Error('boom');
          },
        },
        {
          from: 0,
          describe: 'renames the profile',
          migrate: (raw) => ({
            ...raw,
            profiles: [{ id: 'p', name: 'Renamed' }],
          }),
        },
      ],
      { version: 0, profiles: [{ id: 'p', name: 'Original' }] },
    );

    expect(result.applied).toEqual(['renames the profile']);
    expect(result.config.profiles[0]!.name).toBe('Renamed');
  });

  it('skips steps whose source version is already behind the data', () => {
    const result = runWith(
      [
        {
          from: 0,
          describe: 'should not run',
          migrate: (raw) => ({ ...raw, paused: true }),
        },
      ],
      { version: 1, paused: false, profiles: [{ id: 'p', name: 'P' }] },
    );

    expect(result.applied).toEqual([]);
    expect(result.config.paused).toBe(false);
  });
});
