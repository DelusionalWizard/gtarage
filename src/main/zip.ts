/**
 * A minimal, dependency-free ZIP reader.
 *
 * Mod archives are almost always ZIPs, and so are OpenIV `.oiv` packages and
 * the `.pak`-carrying archives the Definitive Edition scene ships, so one
 * reader covers the common case. Node already bundles the only hard part
 * (raw DEFLATE via zlib), leaving the container format to parse by hand.
 *
 * Deliberately not supported: encrypted entries, and ZIP64 archives above the
 * 4 GB / 65535-entry limits. Those raise a clear error rather than silently
 * extracting a truncated mod, which would be far worse.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import { ensureDir, safeJoin } from './fsutil';

const inflateRawAsync = promisify(inflateRaw);

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  /** Path inside the archive, forward-slashed. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  /** Bit 0 of the general purpose flag: the entry is encrypted. */
  encrypted: boolean;
}

/**
 * Locate the End Of Central Directory record, scanning back from the tail.
 *
 * The four signature bytes are not proof on their own: compressed data is
 * effectively random, so `PK\x05\x06` turns up inside it by chance often
 * enough to matter. Each candidate is therefore checked for self-consistency
 * -- the central directory it points at must actually start with a central
 * directory header, and must end exactly where the EOCD begins -- and only a
 * candidate that passes is accepted.
 */
function findEocd(buf: Buffer): number {
  // The EOCD is 22 bytes plus a comment of up to 64 KB.
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  let firstSignature = -1;

  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    if (firstSignature < 0) firstSignature = i;

    const centralSize = buf.readUInt32LE(i + 12);
    const centralOffset = buf.readUInt32LE(i + 16);

    // ZIP64 sentinels: let the caller report that specifically.
    if (centralOffset === 0xffffffff || centralSize === 0xffffffff) return i;

    if (
      centralOffset + centralSize === i &&
      centralOffset + 4 <= buf.length &&
      buf.readUInt32LE(centralOffset) === SIG_CENTRAL
    ) {
      return i;
    }
  }

  // Nothing verified. Return the raw match so the caller's error mentions the
  // real problem (a damaged or shuffled archive) rather than "not a ZIP".
  return firstSignature;
}

/** Read the central directory and return every entry. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === 0xffffffff || centralSize === 0xffffffff || entryCount === 0xffff) {
    throw new Error('ZIP64 archives are not supported. Extract the archive and import the folder.');
  }

  const entries: ZipEntry[] = [];
  let pos = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error('Damaged ZIP: central directory ended early.');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/');

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
      encrypted: (flags & 0x1) !== 0,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Decompress one entry's bytes. */
async function readEntryData(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  const off = entry.localHeaderOffset;
  // Bounds-check before reading: a bogus offset from a damaged central
  // directory would otherwise throw a raw RangeError from readUInt32LE.
  if (off < 0 || off + 30 > buf.length) {
    throw new Error(`Damaged ZIP: bad local header for ${entry.name}`);
  }
  if (buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw new Error(`Damaged ZIP: bad local header for ${entry.name}`);
  }
  // The local header's name/extra lengths can differ from the central
  // directory's, so the data offset must be computed from the local record.
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;

  // `subarray` silently clamps out-of-range bounds, so a truncated archive
  // would otherwise yield a short file with no error at all -- a half-written
  // .asi deploys perfectly and simply never loads.
  if (start + entry.compressedSize > buf.length) {
    throw new Error(`Damaged ZIP: ${entry.name} extends past the end of the file.`);
  }
  const raw = buf.subarray(start, start + entry.compressedSize);

  let out: Buffer;
  if (entry.compressionMethod === 0) {
    out = Buffer.from(raw);
  } else if (entry.compressionMethod === 8) {
    out = (await inflateRawAsync(raw)) as Buffer;
  } else {
    throw new Error(
      `${entry.name} uses an unsupported compression method (${entry.compressionMethod}). Extract it manually and import the folder.`,
    );
  }

  // The central directory told us how big this file should be. If what we
  // produced disagrees, the archive is damaged -- say so rather than writing
  // a plausible-looking truncated file into the library.
  if (out.length !== entry.uncompressedSize) {
    throw new Error(
      `Damaged ZIP: ${entry.name} unpacked to ${out.length} bytes, expected ${entry.uncompressedSize}.`,
    );
  }

  return out;
}

/**
 * Extract an archive into `destDir`.
 *
 * Entry names are untrusted input, so every one is resolved through
 * `safeJoin`: an archive containing `../../autoexec.bat` is rejected instead
 * of being written outside the destination.
 */
export async function extractZip(archivePath: string, destDir: string): Promise<string[]> {
  const buf = await fs.readFile(archivePath);
  const entries = readZipEntries(buf);

  if (entries.some((e) => e.encrypted)) {
    throw new Error('This archive is password-protected. Extract it manually and import the folder.');
  }

  await ensureDir(destDir);
  const written: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const dest = safeJoin(destDir, entry.name);
    await ensureDir(path.dirname(dest));
    await fs.writeFile(dest, await readEntryData(buf, entry));
    written.push(entry.name);
  }

  return written;
}

/** True when the extension is an archive this reader can open. */
export function isSupportedArchive(file: string): boolean {
  return /\.(zip|oiv)$/i.test(file);
}

/** True when it is an archive we recognise but cannot open ourselves. */
export function isUnsupportedArchive(file: string): boolean {
  return /\.(rar|7z|tar|gz|bz2)$/i.test(file);
}
