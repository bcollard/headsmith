/* A deterministic ZIP writer.
 *
 * The Chrome Web Store signs the .crx itself from an uploaded .zip -- the
 * developer never signs anything, and nothing links the published bytes to a
 * commit. That is the trust gap both reference extensions leave open, and the
 * only way to close it is to make the zip a pure function of the source, then
 * attest to it. A zip that embeds the local clock or the filesystem's
 * directory order is not a pure function of anything.
 *
 * So, three sources of nondeterminism removed:
 *
 *   1. **Timestamps.** Every entry gets a fixed DOS timestamp rather than its
 *      mtime. (1980-01-01 is the epoch the DOS format can represent; it cannot
 *      encode anything earlier, so SOURCE_DATE_EPOCH values below it are
 *      clamped rather than silently wrapping.)
 *   2. **Entry order.** Entries are sorted by path, not taken in readdir
 *      order, which varies by filesystem.
 *   3. **Metadata.** No extra fields, no file comments, no external attributes,
 *      no data descriptors. Every optional field is written as a constant.
 *
 * `zlib.deflateSync` at a fixed level is the one remaining input: its output is
 * stable for a given zlib build, which is why the Node version is pinned in
 * .nvmrc and used verbatim in CI. Anyone reproducing the build on that Node
 * version gets the same bytes; a different one may differ, and the verify
 * script says so rather than reporting a mismatch as tampering.
 */

import { deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

/* The earliest instant the DOS timestamp format can encode. Used as the
   default so the output does not depend on when it was built. */
export const DOS_EPOCH = Date.UTC(1980, 0, 1, 0, 0, 0);

function dosDateTime(epochMs) {
  const d = new Date(Math.max(epochMs, DOS_EPOCH));
  const date =
    (((d.getUTCFullYear() - 1980) & 0x7f) << 9) |
    (((d.getUTCMonth() + 1) & 0x0f) << 5) |
    (d.getUTCDate() & 0x1f);
  const time =
    ((d.getUTCHours() & 0x1f) << 11) |
    ((d.getUTCMinutes() & 0x3f) << 5) |
    ((d.getUTCSeconds() >> 1) & 0x1f);
  return { date, time };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/* Builds a zip from `[{ path, data }]`. Returns a Buffer.
 *
 * `path` uses forward slashes regardless of host platform, as the format
 * requires -- a backslash in a zip entry name is a literal character, not a
 * separator, and produces an archive Chrome will reject. */
export function createZip(entries, { epochMs = DOS_EPOCH } = {}) {
  const { date, time } = dosDateTime(epochMs);

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);

    const deflated = deflateRawSync(raw, { level: 9 });
    /* Store rather than deflate when compression does not help. Keeps small
       already-compressed files (the PNGs) from growing, and the choice is a
       pure function of the content so it stays deterministic. */
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORED;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags -- no data descriptor, no utf8 bit
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    /* Version made by: 20 (MS-DOS, spec 2.0). Deliberately not a Unix value,
       which would invite writing external attributes that encode the umask. */
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes -- no file mode
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* Reads SOURCE_DATE_EPOCH if set, per the reproducible-builds convention.
   Unset is the normal case and gives the fixed DOS epoch. */
export function epochFromEnv(env = process.env) {
  const raw = env['SOURCE_DATE_EPOCH'];
  if (!raw) return DOS_EPOCH;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DOS_EPOCH;
  return Math.max(seconds * 1000, DOS_EPOCH);
}
