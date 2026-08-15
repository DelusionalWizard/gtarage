/**
 * The deployment engine.
 *
 * Deploying a profile means making the game folder match a desired set of
 * files, and being able to put it back exactly as it was. Three invariants
 * hold that together:
 *
 *  1. **Every write is recorded.** The manifest lists each path Swapmeet
 *     created and, when it displaced a real game file, where the original was
 *     parked. Undeploy replays it in reverse.
 *  2. **Nothing outside the game folder is touched**, and nothing inside a
 *     protected path is touched at all.
 *  3. **Deployment is incremental.** Files common to the old and new profile
 *     are left alone, so switching between two 8 GB profiles that share a
 *     texture pack moves only the difference.
 *
 * Hard links do the heavy lifting: a deployed file is a second directory
 * entry for bytes that already exist in the library, so a deploy costs
 * almost no disk space and runs at metadata speed.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getGame } from '../shared/games';
import { activeMods, targetPath } from '../shared/planner';
import type {
  AppConfig,
  DeployManifest,
  DeployedFile,
  GameId,
  Mod,
  Profile,
} from '../shared/types';
import {
  ensureDir,
  exists,
  linkOrCopy,
  move,
  pruneEmptyDirs,
  removeFile,
  readJson,
  safeJoin,
  sameVolume,
  toPosix,
  writeJson,
} from './fsutil';
import { shelfFor } from './config';

const execFileAsync = promisify(execFile);

/** Progress callback so the UI can show something during a long swap. */
export type ProgressFn = (done: number, total: number, label: string) => void;

export function manifestPath(config: AppConfig, gameId: GameId): string {
  return path.join(shelfFor(config, gameId), 'deployed.json');
}

function backupRoot(config: AppConfig, gameId: GameId): string {
  return path.join(shelfFor(config, gameId), 'displaced');
}

export async function readManifest(
  config: AppConfig,
  gameId: GameId,
): Promise<DeployManifest | null> {
  return readJson<DeployManifest>(manifestPath(config, gameId));
}

/**
 * Reject targets inside a protected path. These are the base game's own
 * executables and archives: a mod archive that tries to overwrite `GTA5.exe`
 * or a `pakchunk` is either broken or hostile, and either way we decline.
 *
 * Matching is on whole path segments. A bare `startsWith` was too greedy: it
 * made `x64` protect an ordinary `x64_textures.asi`, and `update` protect
 * `updater.dll`, so perfectly good mods were silently skipped. Where a genuine
 * prefix is wanted -- the numbered `pakchunk0.pak`, `pakchunk1.pak`, ... of the
 * Definitive Editions -- the entry ends in `*` and says so explicitly.
 */
function isProtected(gameId: GameId, target: string): boolean {
  const lower = toPosix(target).toLowerCase();
  return getGame(gameId).protectedPaths.some((p) => {
    const raw = toPosix(p).toLowerCase();
    if (raw.endsWith('*')) {
      // Explicit wildcard: `pakchunk*` guards pakchunk0.pak and friends.
      return lower.startsWith(raw.slice(0, -1));
    }
    // Otherwise the target must be the path itself or sit inside it.
    return lower === raw || lower.startsWith(`${raw}/`);
  });
}

/** The complete set of files a profile wants in the game folder. */
interface DesiredFile {
  target: string;
  modId: string;
  source: string;
}

export function desiredFiles(profile: Profile, mods: Mod[]): Map<string, DesiredFile> {
  const out = new Map<string, DesiredFile>();
  // activeMods returns load order, so later mods overwrite earlier claims.
  for (const mod of activeMods(profile, mods)) {
    for (const rel of mod.files) {
      const target = targetPath(mod, rel);
      out.set(target, { target, modId: mod.id, source: path.join(mod.path, rel) });
    }
  }
  return out;
}

// --- running-game guard -----------------------------------------------------

/**
 * Launcher shims that appear in a game's executable list but are not the game.
 *
 * `PlayGTAV.exe` and friends start the real process and then hang around (or
 * are simply always present because the storefront is open). Treating them as
 * "the game is running" is what made this check fire constantly.
 */
const LAUNCHER_SHIMS = new Set([
  'playgtav.exe',
  'gtavlauncher.exe',
  'playgtaiv.exe',
  'launcher.exe',
]);

/**
 * The process names that mean this game is actually running.
 *
 * Only the game's own executable counts. An open storefront does not: Steam,
 * the Epic launcher and the Rockstar launcher sit in the tray for most people
 * permanently, they do not hold the game's mod folders open, and refusing to
 * deploy because Steam exists made the feature useless.
 */
function gameProcessNames(gameId: GameId): Set<string> {
  const def = getGame(gameId);
  return new Set(
    def.executables
      .map((e) => path.basename(e).toLowerCase())
      .filter((name) => !LAUNCHER_SHIMS.has(name)),
  );
}

/** Currently running process names, lower-cased. */
async function runningProcesses(): Promise<Set<string>> {
  const { stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh']);
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    // Each row is: "image.exe","pid","session",...
    const match = line.match(/^"([^"]+)"/);
    if (match?.[1]) names.add(match[1].toLowerCase());
  }
  return names;
}

/**
 * True when the game itself is running. Deploying into a running game
 * corrupts the install, so this is a hard blocker -- which is exactly why it
 * has to be accurate rather than merely cautious.
 */
export async function isGameRunning(gameId: GameId): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const running = await runningProcesses();
    for (const name of gameProcessNames(gameId)) {
      if (running.has(name)) return true;
    }
    return false;
  } catch {
    // If we cannot tell, do not invent a blocker.
    return false;
  }
}

/** The game process names found running, for a precise error message. */
export async function runningGameProcesses(gameId: GameId): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    const running = await runningProcesses();
    return [...gameProcessNames(gameId)].filter((name) => running.has(name));
  } catch {
    return [];
  }
}

// --- undeploy ---------------------------------------------------------------

/** The outcome of removing a set of deployed files. */
interface RemovalResult {
  problems: string[];
  /**
   * Entries that could not be removed and are therefore *still deployed*.
   * They must stay in the manifest: for a displaced file the manifest holds
   * the only record of where the original is parked.
   */
  remaining: DeployedFile[];
}

/**
 * Remove a set of deployed files and restore anything they displaced.
 * Errors on individual files are collected rather than thrown, so one locked
 * file cannot leave the game folder half-reverted.
 */
async function removeDeployed(
  gamePath: string,
  files: DeployedFile[],
  onProgress?: ProgressFn,
): Promise<RemovalResult> {
  const problems: string[] = [];
  const remaining: DeployedFile[] = [];
  let done = 0;

  for (const file of files) {
    try {
      const abs = safeJoin(gamePath, file.target);
      await removeFile(abs);
      if (file.backup && (await exists(file.backup))) {
        // Put the game's own file back exactly where it came from.
        await move(file.backup, abs);
      } else {
        await pruneEmptyDirs(path.dirname(abs), gamePath);
      }
    } catch (err) {
      problems.push(`${file.target}: ${(err as Error).message}`);
      remaining.push(file);
    }
    onProgress?.(++done, files.length, `Removing ${file.target}`);
  }

  return { problems, remaining };
}

/**
 * Undeploy everything currently laid down for a game.
 *
 * The manifest is only discarded once the game folder is actually clean. If a
 * file could not be removed -- locked by an antivirus scanner, say -- its
 * entry is kept, because that entry names the shelf copy of the game file it
 * displaced. Deleting the manifest at that point would strand the original
 * with nothing left to say where it belonged.
 */
export async function undeployAll(
  config: AppConfig,
  gameId: GameId,
  gamePath: string,
  onProgress?: ProgressFn,
): Promise<string[]> {
  const manifest = await readManifest(config, gameId);
  if (!manifest) return [];
  const { problems, remaining } = await removeDeployed(gamePath, manifest.files, onProgress);

  if (remaining.length > 0) {
    await writeJson(manifestPath(config, gameId), { ...manifest, files: remaining });
  } else {
    await fs.rm(manifestPath(config, gameId), { force: true });
  }

  return problems;
}

// --- deploy -----------------------------------------------------------------

export interface DeployResult {
  manifest: DeployManifest;
  added: number;
  removed: number;
  kept: number;
  /** Non-fatal problems, surfaced to the user afterwards. */
  problems: string[];
}

/**
 * Make the game folder match `profile`.
 *
 * The diff against the existing manifest is what makes this fast and safe:
 * a path already deployed by the same mod is left completely untouched.
 */
export async function deployProfile(
  config: AppConfig,
  gameId: GameId,
  gamePath: string,
  profile: Profile,
  mods: Mod[],
  onProgress?: ProgressFn,
): Promise<DeployResult> {
  const previous = await readManifest(config, gameId);
  const desired = desiredFiles(profile, mods);
  const problems: string[] = [];

  // Refuse anything aimed at a protected path before writing a single byte.
  for (const target of desired.keys()) {
    if (isProtected(gameId, target)) {
      problems.push(`Skipped ${target}: it is part of the base game install.`);
      desired.delete(target);
    }
  }

  const previousByTarget = new Map(
    (previous?.files ?? []).map((f) => [f.target, f]),
  );

  // Stale: deployed before, but not wanted now, or now owned by a different mod.
  const stale = (previous?.files ?? []).filter((f) => {
    const want = desired.get(f.target);
    return !want || want.modId !== f.modId;
  });

  const removal = await removeDeployed(gamePath, stale, onProgress);
  problems.push(...removal.problems);
  for (const f of stale) previousByTarget.delete(f.target);

  // Files we failed to remove are still on disk and may still hold a backup
  // reference. Carry them into the new manifest so undeploy can try again.
  const stranded = removal.remaining;

  const preferHardlink =
    config.settings.useHardlinks && (await sameVolume(config.libraryPath, gamePath));
  if (config.settings.useHardlinks && !preferHardlink) {
    problems.push(
      'The mod library and the game are on different drives, so files were copied instead of hard-linked. Moving the library onto the game drive makes swaps much faster.',
    );
  }

  const backups = backupRoot(config, gameId);
  const files: DeployedFile[] = [];
  let added = 0;
  let kept = 0;
  let done = 0;

  for (const want of desired.values()) {
    const existingEntry = previousByTarget.get(want.target);
    if (existingEntry) {
      // Same mod owns the same path: leave it exactly as it is.
      files.push(existingEntry);
      kept += 1;
      onProgress?.(++done, desired.size, `Keeping ${want.target}`);
      continue;
    }

    let backup: string | undefined;
    try {
      const abs = safeJoin(gamePath, want.target);

      if (await exists(abs)) {
        // Something is already there that we did not put there: it belongs to
        // the base game. Park it in the shelf so undeploy can restore it.
        backup = safeJoin(backups, want.target);
        await ensureDir(path.dirname(backup));
        await move(abs, backup);
      }

      const method = await linkOrCopy(want.source, abs, preferHardlink);
      const entry: DeployedFile = { target: want.target, modId: want.modId, method };
      if (backup) entry.backup = backup;
      files.push(entry);
      added += 1;
    } catch (err) {
      problems.push(`${want.target}: ${(err as Error).message}`);
      // If we had already displaced a real game file before failing, the
      // manifest is the only thing that knows where it went. Record it even
      // though the mod file never landed, or undeploy can never restore it.
      if (backup && (await exists(backup))) {
        files.push({
          target: want.target,
          modId: want.modId,
          method: 'copy',
          backup,
        });
      }
    }
    onProgress?.(++done, desired.size, `Installing ${want.target}`);
  }

  // Anything we could not remove is still in the game folder, so it belongs in
  // the record of what is deployed -- unless the new profile has since claimed
  // the same path, in which case the entry above supersedes it.
  const claimed = new Set(files.map((f) => f.target));
  for (const entry of stranded) {
    if (!claimed.has(entry.target)) files.push(entry);
  }

  const manifest: DeployManifest = {
    version: 1,
    gameId,
    profileId: profile.id,
    gamePath,
    deployedAt: new Date().toISOString(),
    files,
  };
  await writeJson(manifestPath(config, gameId), manifest);

  return { manifest, added, removed: stale.length, kept, problems };
}

// --- verification -----------------------------------------------------------

export interface VerifyReport {
  /** Files the manifest expects but which are missing from the game folder. */
  missing: string[];
  /** Files present in the game folder that Swapmeet did not put there. */
  orphans: string[];
  /** True when the folder matches the manifest exactly. */
  clean: boolean;
}

/**
 * Check the game folder against the manifest.
 *
 * For the vanilla-locked profile this is the online-safety check: it answers
 * "is this install actually unmodded right now?" rather than "does Swapmeet
 * think it is?". Orphan detection looks for the tell-tale loose files that
 * mods leave behind even when a manager believes it removed them.
 */
export async function verifyGameFolder(
  config: AppConfig,
  gameId: GameId,
  gamePath: string,
): Promise<VerifyReport> {
  const manifest = await readManifest(config, gameId);
  const missing: string[] = [];
  const orphans: string[] = [];

  for (const file of manifest?.files ?? []) {
    if (!(await exists(path.join(gamePath, file.target)))) missing.push(file.target);
  }

  const known = new Set((manifest?.files ?? []).map((f) => f.target.toLowerCase()));
  const def = getGame(gameId);

  // Only look where mods actually land; walking a 100 GB install would be
  // pointless and slow.
  const suspectRoots = new Set(
    Object.values(def.deployRoots).filter((r): r is string => Boolean(r)),
  );
  const looseSignatures = /\.(asi|dll|cs|cm|lua|pak|ucas|utoc|oiv)$/i;

  for (const root of ['', ...suspectRoots]) {
    const dir = root ? path.join(gamePath, root) : gamePath;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = toPosix(root ? `${root}/${entry.name}` : entry.name);
      if (known.has(rel.toLowerCase())) continue;
      if (isProtected(gameId, rel)) continue;
      if (looseSignatures.test(entry.name)) orphans.push(rel);
    }
  }

  return { missing, orphans, clean: missing.length === 0 && orphans.length === 0 };
}
