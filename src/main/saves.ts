/**
 * Save-game snapshots.
 *
 * Swapping mods should never be the reason a save is lost. Before every
 * profile swap Swapmeet copies the game's save folder into the shelf, keeps a
 * bounded number of snapshots and prunes the oldest. Saves are small next to
 * a modded install, so this is cheap insurance.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getGame } from '../shared/games';
import type { AppConfig, GameId } from '../shared/types';
import { dirSize, ensureDir, exists } from './fsutil';
import { shelfFor } from './config';

export interface SaveSnapshot {
  id: string;
  gameId: GameId;
  createdAt: string;
  label: string;
  path: string;
  size: number;
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
        createdAt: stat.mtime.toISOString(),
        label: name,
        path: dir,
        size: await dirSize(dir),
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
