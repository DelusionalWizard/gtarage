/**
 * The deployment engine.
 *
 * Deploying a profile means making the game folder match a desired set of
 * files, and being able to put it back exactly as it was. Three invariants
 * hold that together:
 *
 *  1. **Every write is recorded.** The manifest lists each path GTArage
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
  isInside,
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
/**
 * Turn a filesystem error into something a person can act on.
 *
 * `EPERM: operation not permitted, unlink '...'` is technically accurate and
 * completely useless: on Windows it is what you get when the file is open in
 * another process, which for a `.asi` sitting in a game folder almost always
 * means the game is running with that plugin loaded. The callers guard
 * against that up front, but the game can still be started mid-operation, so
 * the message has to explain itself rather than leaking errno.
 */
function describeFileError(err: unknown, target: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    return (
      `${path.basename(target)} is in use — the game is almost certainly running ` +
      'with this mod loaded. Close it and try again.'
    );
  }
  if (code === 'ENOSPC') return 'the drive is full.';
  return (err as Error).message;
}

/**
 * Which ancestors of `dir` do not exist yet, outermost first.
 *
 * Called before the directory is created, so the answer is exactly the set
 * this deploy is about to bring into being.
 */
async function missingDirs(gamePath: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let current = path.resolve(dir);
  const stop = path.resolve(gamePath);
  while (current !== stop && isInside(stop, current)) {
    if (await exists(current)) break;
    out.unshift(toPosix(path.relative(stop, current)));
    current = path.dirname(current);
  }
  return out;
}

/**
 * Move directories this deploy created into the shelf, leftovers and all.
 *
 * Anything still inside was written after we made the folder - a log, a
 * config, a preset the user saved - and is not ours to delete. It is also not
 * the game's, because the folder did not exist before we made it. So the whole
 * thing goes to the shelf, where it can be recovered, and the game folder is
 * genuinely left as it was found.
 */
async function shelveCreatedDirs(
  config: AppConfig,
  gameId: GameId,
  gamePath: string,
  dirs: string[],
): Promise<string[]> {
  const problems: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(shelfFor(config, gameId), 'leftovers', stamp);

  /*
   * Shallowest first, so a parent is moved whole and takes its children with
   * it.
   *
   * Deepest-first is the intuitive order and is wrong: shelving
   * "chaosmod/twitch" creates "leftovers/<stamp>/chaosmod/" on the way, and
   * the subsequent move of "chaosmod" itself then collides with a directory
   * that did not exist when the pass started. Going outermost-in means the
   * inner entries are simply gone by the time they come up, and are skipped.
   */
  for (const rel of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    // Never touch part of the base game, however the record got there.
    if (isProtected(gameId, rel)) continue;
    let abs: string;
    try {
      abs = safeJoin(gamePath, rel);
    } catch {
      continue;
    }
    if (!(await exists(abs))) continue;

    try {
      const entries = await fs.readdir(abs);
      if (entries.length === 0) {
        await fs.rmdir(abs);
        continue;
      }
      const dest = path.join(root, rel);
      await ensureDir(path.dirname(dest));
      await move(abs, dest);
    } catch (err) {
      problems.push(`${rel}: ${describeFileError(err, rel)}`);
    }
  }
  return problems;
}

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
      problems.push(`${file.target}: ${describeFileError(err, file.target)}`);
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

  // Only once every file is out: a directory still holding one of our own
  // files is not a leftover, it is a failed removal.
  if (remaining.length === 0) {
    problems.push(
      ...(await shelveCreatedDirs(config, gameId, gamePath, manifest.createdDirs ?? [])),
    );
  }

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

  /*
   * Check the library still has what it claims, before touching anything.
   *
   * A mod's files can vanish underneath the index: antivirus quarantines an
   * .asi, a cloud-sync client reclaims a folder, an import dies half-way, or
   * someone tidies up by hand. Without this, deployment discovers each
   * missing file individually and reports one ENOENT per file — a mod with
   * twenty files produced twenty near-identical error toasts naming a path
   * the user never chose, and no statement of the actual problem.
   *
   * One check, one message per mod, and the rest of the profile still
   * deploys.
   */
  const missingSources = new Map<string, number>();
  for (const [target, want] of [...desired]) {
    if (await exists(want.source)) continue;
    missingSources.set(want.modId, (missingSources.get(want.modId) ?? 0) + 1);
    desired.delete(target);
  }

  for (const [modId, count] of missingSources) {
    const mod = mods.find((m) => m.id === modId);
    const name = mod?.name ?? modId;
    problems.push(
      `${name} could not be installed: ${count} of its file(s) are missing from your mod library. ` +
        'Re-install the mod, or remove it from the library to stop this warning.',
    );
  }

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

  /*
   * Directories the previous profile created that this one does not want.
   *
   * A swap has to shelve these for the same reason a full undeploy does: a
   * companion folder the mod wrote into at runtime is neither ours to delete
   * nor the game's to keep. Only the ones nothing incoming still needs are
   * considered, or switching between two profiles that share a mod would
   * shelve a folder out from under the profile arriving.
   */
  const stillWanted = new Set<string>();
  for (const target of desired.keys()) {
    const parts = target.split('/');
    for (let i = 1; i < parts.length; i++) stillWanted.add(parts.slice(0, i).join('/'));
  }
  const abandoned = (previous?.createdDirs ?? []).filter((dir) => !stillWanted.has(dir));
  if (abandoned.length > 0 && removal.remaining.length === 0) {
    problems.push(...(await shelveCreatedDirs(config, gameId, gamePath, abandoned)));
  }

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
  // Directories this deploy had to make, so undeploy knows which are ours.
  const createdDirs = new Set<string>(previous?.createdDirs ?? []);
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

      for (const made of await missingDirs(gamePath, path.dirname(abs))) {
        createdDirs.add(made);
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
    // Deepest last, so undeploy can walk them in reverse and clear children
    // before their parents.
    createdDirs: [...createdDirs].sort((a, b) => a.split('/').length - b.split('/').length),
  };
  await writeJson(manifestPath(config, gameId), manifest);

  return { manifest, added, removed: stale.length, kept, problems };
}

// --- verification -----------------------------------------------------------

export interface VerifyReport {
  /** Files the manifest expects but which are missing from the game folder. */
  missing: string[];
  /** Files present in the game folder that GTArage did not put there. */
  orphans: string[];
  /** True when the folder matches the manifest exactly. */
  clean: boolean;
}

/**
 * Check the game folder against the manifest.
 *
 * For the vanilla-locked profile this is the online-safety check: it answers
 * "is this install actually unmodded right now?" rather than "does GTArage
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
