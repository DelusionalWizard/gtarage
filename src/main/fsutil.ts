/**
 * Filesystem primitives for the deployment engine.
 *
 * Two rules govern this file:
 *
 *  1. Nothing is ever destroyed. A file that would be overwritten is moved to
 *     the shelf first, and its old location is recorded in the manifest.
 *  2. Nothing is written outside a known root. Every target path is checked
 *     against the game directory before it is touched, so a malicious or
 *     merely sloppy archive containing `../../Windows/System32` cannot escape.
 */

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  createReadStream,
  promises as fs,
} from 'node:fs';
import path from 'node:path';

/** A file discovered while walking a directory tree. */
export interface WalkedFile {
  /** Absolute path on disk. */
  abs: string;
  /** Path relative to the walk root, always with forward slashes. */
  rel: string;
  size: number;
}

/** Normalise a path for comparison: forward slashes, no leading slash. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/^\/+/, '');
}

/**
 * True when `child` is inside `parent`. Used to reject archive entries that
 * try to traverse out of the game directory.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Join a root and an untrusted relative path, refusing anything that escapes.
 * Throws rather than returning a sentinel: a traversal attempt is a bug or an
 * attack, never something to silently paper over.
 */
export function safeJoin(root: string, rel: string): string {
  const joined = path.resolve(root, rel);
  if (joined !== path.resolve(root) && !isInside(root, joined)) {
    const err = new Error(
      `Refusing to write outside the target folder: ${rel}`,
    ) as NodeJS.ErrnoException;
    // Tagged so callers can tell a security refusal from "our reader is too
    // simple for this archive". The latter may be retried with an external
    // tool; this must never be, or the containment check is bypassed.
    err.code = 'ERR_UNSAFE_PATH';
    throw err;
  }
  return joined;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively list every file under `root`. Symlinks are not followed.
 *
 * `maxDepth` bounds the descent. That matters where the walk starts inside a
 * game folder: GTA V's `mods/` can hold an entire mirrored copy of the game's
 * archives, and walking it unbounded turns a quick scan into tens of seconds.
 */
export async function walk(root: string, maxDepth = Infinity): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  async function recurse(dir: string, depth = 0): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip rather than abort the whole walk
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await recurse(abs, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        out.push({ abs, rel: toPosix(path.relative(root, abs)), size: stat.size });
      }
    }
  }

  await recurse(root);
  return out;
}

/** Total byte size of a directory tree. */
export async function dirSize(root: string): Promise<number> {
  const files = await walk(root);
  return files.reduce((sum, f) => sum + f.size, 0);
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Place `src` at `dest`, preferring a hard link.
 *
 * Hard links are why Swapmeet can hold a dozen profiles of a 100 GB game
 * without a dozen copies: the link is a second directory entry pointing at
 * bytes that already exist. They only work within a single volume, so we fall
 * back to copying when the library and the game sit on different drives.
 *
 * Returns which method was actually used, so the manifest can record it.
 */
export async function linkOrCopy(
  src: string,
  dest: string,
  preferHardlink: boolean,
): Promise<'hardlink' | 'copy'> {
  await ensureDir(path.dirname(dest));
  if (preferHardlink) {
    try {
      await fs.link(src, dest);
      return 'hardlink';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EXDEV: cross-device. EPERM/EACCES: filesystem refuses links.
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw err;
    }
  }
  await fs.copyFile(src, dest);
  return 'copy';
}

/** Move a file, falling back to copy+unlink across volumes. */
export async function move(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/** Delete a file, treating "already gone" as success. */
export async function removeFile(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Remove `dir` and every empty parent up to (but never including) `stopAt`.
 * Keeps the game folder tidy after an undeploy without ever removing a
 * directory that still holds real game files.
 */
export async function pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current !== stop && isInside(stop, current)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) return;
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** Free bytes on the volume holding `p`. Returns null when unavailable. */
export async function freeSpace(p: string): Promise<number | null> {
  try {
    const stat = await fs.statfs(p);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/** True when both paths sit on the same volume, so hard links can work. */
export async function sameVolume(a: string, b: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return path.parse(path.resolve(a)).root.toLowerCase() ===
      path.parse(path.resolve(b)).root.toLowerCase();
  }
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** SHA-1 of a file, streamed. Used to tell a deployed link from a stray file. */
export async function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Read JSON, distinguishing "not there" from "damaged".
 *
 * `readJson` cannot tell those apart, which matters enormously for the config:
 * treating a corrupt file as a missing one starts the app as if freshly
 * installed and then overwrites the damaged file, losing every profile the
 * user ever built. Callers that own irreplaceable state use this instead.
 */
export async function readJsonStrict<T>(
  p: string,
): Promise<{ ok: true; data: T | null } | { ok: false; error: Error; raw: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, data: null };
    return { ok: false, error: err as Error, raw: '' };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch (err) {
    return { ok: false, error: err as Error, raw };
  }
}

/**
 * Write JSON atomically: a torn config file after a power cut would lose every
 * profile the user has built.
 *
 * The temp file name is unique per write. A fixed `.tmp` meant two overlapping
 * writers shared one scratch file, so one could rename a half-written file
 * into place -- producing exactly the torn config this function exists to
 * prevent. The handle is flushed before the rename so a power cut cannot
 * publish an empty file either.
 */
let tmpCounter = 0;
export async function writeJson(p: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
