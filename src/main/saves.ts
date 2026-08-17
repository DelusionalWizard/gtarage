/**
 * Save-game snapshots.
 *
 * Swapping mods should never be the reason a save is lost. Before every
 * profile swap GTArage copies the game's save folder into the shelf, keeps a
 * bounded number of snapshots and prunes the oldest. Saves are small next to
 * a modded install, so this is cheap insurance.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getGame } from '../shared/games';
import type { AppConfig, GameId } from '../shared/types';
import { dirSize, ensureDir, exists, walk } from './fsutil';
import { shelfFor } from './config';

export interface SaveSnapshot {
  id: string;
  gameId: GameId;
  /** When GTArage took the snapshot. */
  createdAt: string;
  label: string;
  path: string;
  size: number;
  /**
   * When the game itself last wrote the newest save inside this snapshot.
   *
   * Distinct from `createdAt`, and the more useful of the two when you are
   * hunting for a particular point in your playthrough: the snapshot time
   * only says when you swapped profiles, whereas this says how far along the
   * save actually is.
   */
  savedAt?: string;
  /** Number of save files captured. */
  fileCount: number;
}

/**
 * The newest modification time among a snapshot's files, and how many there
 * are. That timestamp is the game's own, since GTArage copies files without
 * rewriting their contents.
 */
async function newestSaveTime(
  dir: string,
): Promise<{ savedAt?: string; fileCount: number }> {
  const files = await walk(dir);
  let newest = 0;
  for (const file of files) {
    try {
      const stat = await fs.stat(file.abs);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // skip unreadable entries
    }
  }
  return newest > 0
    ? { savedAt: new Date(newest).toISOString(), fileCount: files.length }
    : { fileCount: files.length };
}

/**
 * Recover the snapshot instant from its folder name.
 *
 * Snapshot ids are an ISO timestamp with `:` and `.` swapped for `-`, since
 * those are illegal in Windows paths. Reading the id back is more reliable
 * than the folder's mtime, which changes if the folder is ever copied or
 * moved — as happens during a data migration.
 */
function parseSnapshotId(id: string): string | null {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function snapshotRoot(config: AppConfig, gameId: GameId): string {
  return path.join(shelfFor(config, gameId), 'saves');
}

/** The user's Documents folder, where every GTA title keeps its saves. */
function documentsDir(): string {
  return path.join(os.homedir(), 'Documents');
}

/** Absolute save folders for a game that actually exist on this machine. */
export async function saveFolders(gameId: GameId): Promise<string[]> {
  const def = getGame(gameId);
  const out: string[] = [];
  for (const rel of def.savePaths) {
    const abs = path.join(documentsDir(), rel);
    if (await exists(abs)) out.push(abs);
  }
  return out;
}

/** Snapshot the game's saves. Returns null when the game has no saves yet. */
export async function snapshotSaves(
  config: AppConfig,
  gameId: GameId,
  label: string,
): Promise<SaveSnapshot | null> {
  const folders = await saveFolders(gameId);
  if (folders.length === 0) return null;

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(snapshotRoot(config, gameId), id);
  await ensureDir(dest);

  for (const folder of folders) {
    await fs.cp(folder, path.join(dest, path.basename(folder)), {
      recursive: true,
      force: true,
    });
  }

  const snapshot: SaveSnapshot = {
    id,
    gameId,
    createdAt: new Date().toISOString(),
    label,
    path: dest,
    size: await dirSize(dest),
    ...(await newestSaveTime(dest)),
  };

  await pruneSnapshots(config, gameId);
  return snapshot;
}

/** List snapshots, newest first. */
export async function listSnapshots(
  config: AppConfig,
  gameId: GameId,
): Promise<SaveSnapshot[]> {
  const root = snapshotRoot(config, gameId);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }

  const out: SaveSnapshot[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      out.push({
        id: name,
        gameId,
        // The folder name is the ISO instant the snapshot was taken, which
        // survives a copy; mtime does not.
        createdAt: parseSnapshotId(name) ?? stat.mtime.toISOString(),
        label: name,
        path: dir,
        size: await dirSize(dir),
        ...(await newestSaveTime(dir)),
      });
    } catch {
      // Skip anything unreadable.
    }
  }

  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Drop the oldest snapshots beyond the configured limit. */
async function pruneSnapshots(config: AppConfig, gameId: GameId): Promise<void> {
  const limit = Math.max(1, config.settings.saveBackupLimit);
  const all = await listSnapshots(config, gameId);
  for (const old of all.slice(limit)) {
    await fs.rm(old.path, { recursive: true, force: true });
  }
}

/**
 * Restore a snapshot over the live save folders.
 *
 * The current saves are snapshotted first, so restoring the wrong backup is
 * itself undoable.
 */
export async function restoreSnapshot(
  config: AppConfig,
  gameId: GameId,
  snapshotId: string,
): Promise<void> {
  const snapshots = await listSnapshots(config, gameId);
  const snapshot = snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) throw new Error(`No save snapshot named ${snapshotId}.`);

  await snapshotSaves(config, gameId, 'before restore');

  for (const entry of await fs.readdir(snapshot.path)) {
    const target = path.join(documentsDir(), pathForSaveFolder(gameId, entry));
    await ensureDir(path.dirname(target));
    await fs.cp(path.join(snapshot.path, entry), target, {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Map a snapshot subfolder name back to its game-relative save path.
 * Snapshots store folders by base name, so this finds the matching entry in
 * the game definition.
 */
function pathForSaveFolder(gameId: GameId, folderName: string): string {
  const def = getGame(gameId);
  const match = def.savePaths.find((p) => path.basename(p) === folderName);
  return match ?? folderName;
}
