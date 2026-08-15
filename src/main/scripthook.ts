/**
 * Getting ScriptHookV installed without making the user work it out.
 *
 * ScriptHookV is the one thing nearly every GTA V mod needs, and it is the
 * one thing Swapmeet cannot fetch: Alexander Blade distributes it from his
 * own site with no API, and guessing a download URL would be both fragile and
 * rude. So the flow is:
 *
 *  1. Notice it is missing for a game that needs it.
 *  2. Open the official page and say plainly what to download.
 *  3. Watch the user's Downloads folder for the archive to appear, and offer
 *     to install it the moment it does.
 *  4. If a copy is already on the machine — in Downloads, or installed into
 *     one game folder by hand — offer that instead of a fresh download.
 *
 * Step 4 is what makes it feel automatic: most people who reach for a mod
 * manager already have ScriptHookV somewhere.
 *
 * Legacy and Enhanced take different builds, so a copy found for one is never
 * silently installed into the other; each is matched by what it contains.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig, GameId } from '../shared/types';
import { exists, walk } from './fsutil';
import { readZipEntries } from './zip';

/** Games that need ScriptHookV at all. */
const NEEDS_HOOK: GameId[] = ['gta5', 'gta5e'];

/** The official page, which is the only place it is published. */
export const SCRIPTHOOKV_URL = 'http://www.dev-c.com/gtav/scripthookv/';

/** A ScriptHookV archive or folder found somewhere on the machine. */
export interface HookCandidate {
  /** Absolute path to the archive or folder. */
  path: string;
  /** Which game this copy is built for, when we can tell. */
  gameId: GameId | null;
  /** How it was found, for the message shown to the user. */
  source: 'downloads' | 'game-folder';
  /** File modification time, so the newest can be preferred. */
  modifiedAt: string;
  /** The version string parsed out of the name, when there is one. */
  version?: string;
}

/**
 * Decide which game an archive is for.
 *
 * The Enhanced build names its payload differently, so the entry list is the
 * signal rather than the filename, which people rename constantly. Returns
 * null when it genuinely cannot tell, and the caller asks.
 */
function gameFromNames(names: string[]): GameId | null {
  const joined = names.join(' ').toLowerCase();
  if (/enhanced/.test(joined)) return 'gta5e';
  // The Legacy distribution ships the Native Trainer and a bin/ folder.
  if (/scripthookv\.dll/.test(joined)) return 'gta5';
  return null;
}

async function namesInside(file: string): Promise<string[]> {
  if ((await fs.stat(file)).isDirectory()) {
    return (await walk(file)).map((f) => f.rel);
  }
  try {
    const buf = await fs.readFile(file);
    return readZipEntries(buf).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Version out of a filename like `ScriptHookV_1.0.3521.0.zip`. */
function versionFrom(name: string): string | undefined {
  return name.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1];
}

/**
 * Look for a ScriptHookV archive the user has already downloaded.
 *
 * Only the Downloads folder, only names that look like ScriptHookV, and only
 * the top level: this runs on a timer while the prompt is open, so it must
 * stay cheap and must never wander through the whole disk.
 */
export async function findDownloadedHook(): Promise<HookCandidate[]> {
  const downloads = path.join(os.homedir(), 'Downloads');
  if (!(await exists(downloads))) return [];

  let entries;
  try {
    entries = await fs.readdir(downloads, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: HookCandidate[] = [];
  for (const entry of entries) {
    if (!/script\s*hook\s*v/i.test(entry.name)) continue;
    if (entry.isFile() && !/\.(zip|rar|7z)$/i.test(entry.name)) continue;

    const abs = path.join(downloads, entry.name);
    try {
      const stat = await fs.stat(abs);
      const candidate: HookCandidate = {
        path: abs,
        gameId: gameFromNames(await namesInside(abs)) ?? gameFromNames([entry.name]),
        source: 'downloads',
        modifiedAt: stat.mtime.toISOString(),
      };
      const version = versionFrom(entry.name);
      if (version) candidate.version = version;
      out.push(candidate);
    } catch {
      // unreadable; ignore
    }
  }

  // Newest first: people re-download it when a game update breaks the old one.
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Look for ScriptHookV already installed by hand in a game folder.
 *
 * A copy sitting in GTA V's folder is a perfectly good source for setting up
 * Enhanced, and vice versa — but only after checking it is the right build,
 * which is why the whole folder's contents decide the game rather than its
 * location.
 */
export async function findInstalledHook(config: AppConfig): Promise<HookCandidate[]> {
  const out: HookCandidate[] = [];

  for (const install of config.installs) {
    if (!NEEDS_HOOK.includes(install.gameId)) continue;
    const dll = path.join(install.path, 'ScriptHookV.dll');
    if (!(await exists(dll))) continue;
    try {
      const stat = await fs.stat(dll);
      out.push({
        path: install.path,
        // A copy in a game folder is for that game, by definition: it is the
        // build that game is currently running.
        gameId: install.gameId,
        source: 'game-folder',
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // ignore
    }
  }

  return out;
}

/** Games that need ScriptHookV, are installed, and do not have it yet. */
export function gamesMissingHook(config: AppConfig): GameId[] {
  const missing: GameId[] = [];

  for (const install of config.installs) {
    if (!NEEDS_HOOK.includes(install.gameId)) continue;

    // Already in the library for this game?
    const inLibrary = config.mods.some(
      (m) =>
        m.gameId === install.gameId &&
        (/script\s*hook\s*v/i.test(m.name) ||
          m.files.some((f) => /^scripthookv\.dll$/i.test(path.basename(f)))),
    );
    if (!inLibrary) missing.push(install.gameId);
  }

  return missing;
}

/**
 * The files a candidate would contribute, for the confirmation dialog.
 * Only the ones that matter, so the list stays readable.
 */
export async function describeCandidate(candidate: HookCandidate): Promise<string[]> {
  const names = await namesInside(candidate.path);
  const interesting = names.filter((n) =>
    /\.(dll|asi)$/i.test(n),
  );
  return (interesting.length > 0 ? interesting : names).slice(0, 10).map((n) => path.basename(n));
}
