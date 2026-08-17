/**
 * Per-profile graphics and launch settings.
 *
 * A profile swap moves mods, but the game's settings do not live with the
 * mods — `settings.xml` sits in Documents, `commandline.txt` in the game
 * folder, `GameUserSettings.ini` in LocalAppData. So a heavily modded setup
 * that needs lower render settings, and a vanilla one that does not, share a
 * single settings file and overwrite each other. The result is reconfiguring
 * the graphics options by hand after every switch.
 *
 * GTArage fixes that by treating those files as part of the profile:
 *
 *  - **Capture** copies the live settings into the profile's own folder.
 *  - **Restore** puts that profile's copy back when it is applied.
 *
 * The outgoing profile is captured immediately before the incoming one is
 * restored, so changes made in-game are remembered without anyone having to
 * press a button. A profile that has never been captured restores nothing,
 * which leaves the current settings alone rather than resetting them.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getGame } from '../shared/games';
import type { AppConfig, GameId, GraphicsBase, GraphicsFile } from '../shared/types';
import { shelfFor } from './config';
import { ensureDir, exists, readJson, writeJson } from './fsutil';

/** What was captured, so a restore does not depend on registry ordering. */
interface GraphicsManifest {
  version: 1;
  capturedAt: string;
  files: Array<{ base: GraphicsBase; rel: string; stored: string }>;
}

function profileDir(config: AppConfig, gameId: GameId, profileId: string): string {
  return path.join(shelfFor(config, gameId), 'graphics', profileId);
}

function manifestPath(config: AppConfig, gameId: GameId, profileId: string): string {
  return path.join(profileDir(config, gameId, profileId), 'graphics.json');
}

/**
 * Resolve a settings file to an absolute path.
 *
 * Returns null when the root is unknown — LocalAppData on a non-Windows
 * machine, or a game whose install path we do not have — so callers skip it
 * rather than writing to a half-formed path.
 */
export function resolveGraphicsPath(
  file: GraphicsFile,
  gamePath: string | null,
): string | null {
  let root: string | undefined;
  switch (file.base) {
    case 'documents':
      root = path.join(os.homedir(), 'Documents');
      break;
    case 'localappdata':
      root = process.env.LOCALAPPDATA ?? undefined;
      break;
    case 'game':
      root = gamePath ?? undefined;
      break;
  }
  return root ? path.join(root, file.rel) : null;
}

/** A filesystem-safe name for a stored copy. */
function storedName(file: GraphicsFile): string {
  return file.rel.replace(/[\\/]/g, '__');
}

export interface GraphicsFileStatus {
  label: string;
  /** Absolute path of the live file. */
  path: string;
  /** The live file exists right now. */
  live: boolean;
  /** This profile has a captured copy. */
  captured: boolean;
}

export interface GraphicsStatus {
  /** True when the game has any settings worth tracking. */
  supported: boolean;
  /** True when this profile has captured anything. */
  captured: boolean;
  capturedAt?: string;
  files: GraphicsFileStatus[];
}

export async function graphicsStatus(
  config: AppConfig,
  gameId: GameId,
  profileId: string,
  gamePath: string | null,
): Promise<GraphicsStatus> {
  const defs = getGame(gameId).graphicsFiles ?? [];
  if (defs.length === 0) return { supported: false, captured: false, files: [] };

  const manifest = await readJson<GraphicsManifest>(manifestPath(config, gameId, profileId));
  const dir = profileDir(config, gameId, profileId);

  const files: GraphicsFileStatus[] = [];
  for (const def of defs) {
    const abs = resolveGraphicsPath(def, gamePath);
    if (!abs) continue;
    files.push({
      label: def.label,
      path: abs,
      live: await exists(abs),
      captured: await exists(path.join(dir, storedName(def))),
    });
  }

  const status: GraphicsStatus = {
    supported: true,
    captured: Boolean(manifest),
    files,
  };
  if (manifest?.capturedAt) status.capturedAt = manifest.capturedAt;
  return status;
}

/**
 * Copy the live settings into a profile's folder.
 *
 * Returns the number of files captured. Zero is normal and not an error: a
 * game that has never been launched has no settings file yet.
 */
export async function captureGraphics(
  config: AppConfig,
  gameId: GameId,
  profileId: string,
  gamePath: string | null,
): Promise<number> {
  const defs = getGame(gameId).graphicsFiles ?? [];
  if (defs.length === 0) return 0;

  const dir = profileDir(config, gameId, profileId);
  await ensureDir(dir);

  const captured: GraphicsManifest['files'] = [];
  for (const def of defs) {
    const abs = resolveGraphicsPath(def, gamePath);
    if (!abs || !(await exists(abs))) continue;
    const stored = storedName(def);
    try {
      await fs.copyFile(abs, path.join(dir, stored));
      captured.push({ base: def.base, rel: def.rel, stored });
    } catch {
      // A locked settings file is not worth failing a profile swap over.
    }
  }

  if (captured.length === 0) return 0;

  const manifest: GraphicsManifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    files: captured,
  };
  await writeJson(manifestPath(config, gameId, profileId), manifest);
  return captured.length;
}

/**
 * Put a profile's captured settings back.
 *
 * A profile with nothing captured restores nothing and reports 0, which
 * leaves whatever is currently configured alone. That is deliberate: wiping
 * someone's graphics settings because a profile happens to be new would be a
 * far worse failure than not restoring them.
 */
export async function restoreGraphics(
  config: AppConfig,
  gameId: GameId,
  profileId: string,
  gamePath: string | null,
): Promise<number> {
  const manifest = await readJson<GraphicsManifest>(manifestPath(config, gameId, profileId));
  if (!manifest) return 0;

  const dir = profileDir(config, gameId, profileId);
  let restored = 0;

  for (const entry of manifest.files) {
    const abs = resolveGraphicsPath({ base: entry.base, rel: entry.rel, label: '' }, gamePath);
    if (!abs) continue;
    const stored = path.join(dir, entry.stored);
    if (!(await exists(stored))) continue;
    try {
      await ensureDir(path.dirname(abs));
      await fs.copyFile(stored, abs);
      restored += 1;
    } catch {
      // Game running and holding the file open, most likely.
    }
  }

  return restored;
}

/** Forget a profile's captured settings. */
export async function clearGraphics(
  config: AppConfig,
  gameId: GameId,
  profileId: string,
): Promise<void> {
  await fs.rm(profileDir(config, gameId, profileId), { recursive: true, force: true });
}

/**
 * Capture the outgoing profile, then restore the incoming one.
 *
 * Called from the deploy path. Order matters: capturing first is what makes
 * in-game changes stick to the profile they were made under.
 */
export async function swapGraphics(
  config: AppConfig,
  gameId: GameId,
  fromProfileId: string | null,
  toProfileId: string,
  gamePath: string | null,
): Promise<{ captured: number; restored: number }> {
  let captured = 0;
  if (fromProfileId && fromProfileId !== toProfileId) {
    captured = await captureGraphics(config, gameId, fromProfileId, gamePath);
  }
  const restored = await restoreGraphics(config, gameId, toProfileId, gamePath);
  return { captured, restored };
}
