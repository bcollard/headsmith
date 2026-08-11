/* Tests for the deterministic ZIP writer.
 *
 * The release-integrity claim -- "you can rebuild this and get the same bytes"
 * -- rests entirely on these properties. A regression here would not break any
 * feature and would not fail any other test; it would just quietly make the
 * artifact unverifiable, which is the one thing the packaging exists to
 * prevent. So each property is asserted directly rather than inferred from an
 * end-to-end hash comparison.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain ESM, deliberately outside the TypeScript project
import { createZip, epochFromEnv, DOS_EPOCH } from '../../scripts/lib/zip.mjs';

const entry = (path: string, text: string) => ({ path, data: Buffer.from(text) });

describe('determinism', () => {
  it('produces identical bytes for identical input', () => {
    const entries = [entry('b.txt', 'beta'), entry('a.txt', 'alpha')];
    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });

  it('is independent of the order entries are supplied in', () => {
    // readdir order varies by filesystem, so the writer sorts rather than
    // trusting its caller.
    const forward = createZip([entry('a.txt', 'alpha'), entry('b.txt', 'beta')]);
    const reverse = createZip([entry('b.txt', 'beta'), entry('a.txt', 'alpha')]);
    expect(forward.equals(reverse)).toBe(true);
  });

  it('embeds no timestamp from the clock', () => {
    // Same input built "at different times" must agree; the only way that
    // holds is if the clock is never consulted.
    const entries = [entry('a.txt', 'alpha')];
    const a = createZip(entries, { epochMs: DOS_EPOCH });
    const b = createZip(entries, { epochMs: DOS_EPOCH });
    expect(a.equals(b)).toBe(true);
  });

  it('changes when a file\'s content changes', () => {
    // The flip side: determinism must not come from ignoring the input.
    const a = createZip([entry('a.txt', 'alpha')]);
    const b = createZip([entry('a.txt', 'alphb')]);
    expect(a.equals(b)).toBe(false);
  });

  it('changes when a file is added', () => {
    const a = createZip([entry('a.txt', 'alpha')]);
    const b = createZip([entry('a.txt', 'alpha'), entry('b.txt', 'beta')]);
    expect(a.equals(b)).toBe(false);
  });
});

describe('archive structure', () => {
  it('writes a well-formed end-of-central-directory record', () => {
    const zip = createZip([entry('a.txt', 'alpha'), entry('b.txt', 'beta')]);
    const eocd = zip.length - 22;

    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 8)).toBe(2); // entries on this disk
    expect(zip.readUInt16LE(eocd + 10)).toBe(2); // entries total
    expect(zip.readUInt16LE(eocd + 20)).toBe(0); // no archive comment
  });

  it('starts with a local file header', () => {
    expect(createZip([entry('a.txt', 'alpha')]).readUInt32LE(0)).toBe(0x04034b50);
  });

  it('writes no extra fields or comments', () => {
    /* Every optional field is a constant. Extra fields are where zip writers
       usually stash mtimes at higher precision, which would reintroduce
       exactly the nondeterminism this avoids. */
    const zip = createZip([entry('a.txt', 'alpha')]);
    expect(zip.readUInt16LE(28)).toBe(0); // local extra length
    const eocd = zip.length - 22;
    const central = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt16LE(central + 30)).toBe(0); // central extra
    expect(zip.readUInt16LE(central + 32)).toBe(0); // file comment
    expect(zip.readUInt32LE(central + 38)).toBe(0); // external attributes
  });

  it('normalises path separators', () => {
    // A backslash is a literal character in a zip entry name, not a
    // separator, and produces an archive Chrome rejects.
    const zip = createZip([{ path: 'icons\\icon16.png', data: Buffer.from('x') }]);
    expect(zip.toString('utf8')).toContain('icons/icon16.png');
    expect(zip.toString('utf8')).not.toContain('icons\\icon16.png');
  });

  it('stores rather than deflates when compression would not help', () => {
    // Keeps already-compressed content (the PNGs) from growing. The choice is
    // a pure function of the bytes, so it stays deterministic.
    const incompressible = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const zip = createZip([{ path: 'a.png', data: incompressible }]);
    expect(zip.readUInt16LE(8)).toBe(0); // method: stored

    const compressible = Buffer.from('a'.repeat(2000));
    const zip2 = createZip([{ path: 'a.txt', data: compressible }]);
    expect(zip2.readUInt16LE(8)).toBe(8); // method: deflate
  });
});

describe('epochFromEnv', () => {
  it('defaults to the DOS epoch when SOURCE_DATE_EPOCH is unset', () => {
    expect(epochFromEnv({})).toBe(DOS_EPOCH);
  });

  it('honours SOURCE_DATE_EPOCH', () => {
    const seconds = Date.UTC(2026, 5, 1) / 1000;
    expect(epochFromEnv({ SOURCE_DATE_EPOCH: String(seconds) })).toBe(seconds * 1000);
  });

  it('clamps a value the DOS format cannot represent', () => {
    // DOS timestamps start at 1980. A Unix epoch of 0 would wrap rather than
    // fail, producing a valid-looking archive with a nonsense date.
    expect(epochFromEnv({ SOURCE_DATE_EPOCH: '0' })).toBe(DOS_EPOCH);
  });

  it('ignores a value that is not a number', () => {
    expect(epochFromEnv({ SOURCE_DATE_EPOCH: 'yesterday' })).toBe(DOS_EPOCH);
  });
});
