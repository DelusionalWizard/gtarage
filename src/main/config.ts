/**
 * Persisted state: installs, the mod library index, profiles and settings.
 *
 * One JSON file, written atomically, held in memory while the app runs. A mod
 * manager's config is small (a few hundred entries at most) and losing it
 * means losing every profile the user built, so durability matters far more
 * than throughput here.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AppConfig, GameId, Mod, Profile } from '../shared/types';
import { exists, readJsonStrict, writeJson } from './fsutil';


let configPath = '';
let cache: AppConfig | null = null;

/**
 * Set when the config on disk could not be parsed. The app runs on defaults so
 * the user is not locked out, but the damaged file is preserved and nothing is
 * written over it until they decide what to do.
 */
let loadError: { message: string; backupPath: string } | null = null;

export function getConfigError(): { message: string; backupPath: string } | null {
  return loadError;
}

export function defaultConfig(userDataDir: string): AppConfig {
  return {
    version: 1,
    libraryPath: path.join(userDataDir, 'library'),
    shelfPath: path.join(userDataDir, 'shelf'),
    installs: [],
    mods: [],
    profiles: [],
    activeProfile: {},
    settings: {
      backupSavesOnSwap: true,
      saveBackupLimit: 15,
      useHardlinks: true,
      blockWhileGameRunning: true,
      warnAboutOnline: false,
      graphicsPerProfile: true,
    },
  };
}

/**
 * Move a previous installation's data across after the app was renamed.
 *
 * Electron derives `userData` from the product name, so renaming the app also
 * moves that folder — and the user's entire library, profiles and shelf would
 * appear to vanish, with a working install left stranded under the old name.
 * If the new location is empty and the old one exists, its contents are moved
 * over once.
 *
 * Deliberately conservative: it never runs when the new folder already has a
 * config, and a failure is logged rather than thrown, because being unable to
 * migrate is not a reason to refuse to start.
 */
export async function migrateLegacyUserData(
  newDir: string,
  legacyDir: string,
): Promise<string | null> {
  try {
    if (await exists(path.join(newDir, 'swapmeet.config.json'))) return null;
    const legacyConfig = path.join(legacyDir, 'rigging.config.json');
    if (!(await exists(legacyConfig))) return null;

    await fs.mkdir(newDir, { recursive: true });
    for (const entry of await fs.readdir(legacyDir)) {
      const from = path.join(legacyDir, entry);
      const to = path.join(
        newDir,
        entry === 'rigging.config.json' ? 'swapmeet.config.json' : entry,
      );
      if (await exists(to)) continue;
      await fs.rename(from, to).catch(async () => {
        // Across volumes, or locked: fall back to a copy.
        await fs.cp(from, to, { recursive: true });
      });
    }
    return legacyDir;
  } catch (err) {
    console.error('[swapmeet] could not migrate previous data:', err);
    return null;
  }
}

/** Point the store at a directory. Called once, at app startup. */
export function initConfig(userDataDir: string): void {
  configPath = path.join(userDataDir, 'swapmeet.config.json');
  cache = null;
  loadError = null;
}

export function getConfigPath(): string {
  return configPath;
}

/**
 * Merge a loaded config over the defaults so a file written by an older
 * version never leaves a field undefined.
 */
function hydrate(loaded: Partial<AppConfig>, userDataDir: string): AppConfig {
  const base = defaultConfig(userDataDir);
  return {
    ...base,
    ...loaded,
    settings: { ...base.settings, ...(loaded.settings ?? {}) },
    activeProfile: { ...(loaded.activeProfile ?? {}) },
    installs: loaded.installs ?? [],
    mods: loaded.mods ?? [],
    profiles: loaded.profiles ?? [],
    version: 1,
  };
}

export async function loadConfig(userDataDir: string): Promise<AppConfig> {
  if (cache) return cache;

  const result = await readJsonStrict<Partial<AppConfig>>(configPath);

  if (!result.ok) {
    // The file exists but is damaged. Never start fresh and overwrite it --
    // that would destroy every profile, install path and mod index the user
    // has, and it is exactly what a truncated write or a hand-edit looks
    // like. Preserve it under a dated name and tell the user.
    const backupPath = `${configPath}.corrupt-${Date.now()}.json`;
    try {
      await fs.copyFile(configPath, backupPath);
    } catch {
      // If even the copy fails, still refuse to run destructively.
    }
    loadError = {
      message: `Your settings file could not be read (${result.error.message}). Swapmeet has started with default settings and kept a copy of the damaged file.`,
      backupPath,
    };
    cache = defaultConfig(userDataDir);
    return cache;
  }

  cache = result.data ? hydrate(result.data, userDataDir) : defaultConfig(userDataDir);
  return cache;
}

/**
 * Serialise config writes.
 *
 * Every IPC handler can save, and they run concurrently, so two overlapping
 * read-modify-write cycles could otherwise interleave and publish a torn file.
 * Chaining them costs nothing at this size and removes the race entirely.
 */
let writeChain: Promise<void> = Promise.resolve();

export async function saveConfig(config: AppConfig): Promise<void> {
  cache = config;
  const next = writeChain.then(
    () => writeJson(configPath, config),
    () => writeJson(configPath, config),
  );
  writeChain = next.catch(() => {});
  await next;
}

/**
 * The already-loaded config, synchronously.
 *
 * Only safe after startup has called `loadConfig` once, which it always does.
 * Exists for callbacks that cannot await -- notably the download-capture hook,
 * which fires from an Electron event handler.
 */
export function peekConfig(): AppConfig {
  if (!cache) throw new Error('Config has not been loaded yet.');
  return cache;
}

/** Read-modify-write helper so callers cannot forget to persist. */
export async function updateConfig(
  userDataDir: string,
  mutate: (config: AppConfig) => void | Promise<void>,
): Promise<AppConfig> {
  const config = await loadConfig(userDataDir);
  await mutate(config);
  await saveConfig(config);
  return config;
}

// --- convenience accessors --------------------------------------------------

export function modsForGame(config: AppConfig, gameId: GameId): Mod[] {
  return config.mods.filter((m) => m.gameId === gameId);
}

export function profilesForGame(config: AppConfig, gameId: GameId): Profile[] {
  return config.profiles.filter((p) => p.gameId === gameId);
}

export function findProfile(config: AppConfig, id: string): Profile | null {
  return config.profiles.find((p) => p.id === id) ?? null;
}

export function activeProfileFor(config: AppConfig, gameId: GameId): Profile | null {
  const id = config.activeProfile[gameId];
  return id ? findProfile(config, id) : null;
}

export function installFor(config: AppConfig, gameId: GameId) {
  return config.installs.find((i) => i.gameId === gameId) ?? null;
}

/** Where a game's shelved files and save snapshots live. */
export function shelfFor(config: AppConfig, gameId: GameId): string {
  return path.join(config.shelfPath, gameId);
}

/** Where a game's mod files live in the library. */
export function libraryFor(config: AppConfig, gameId: GameId): string {
  return path.join(config.libraryPath, gameId);
}

/**
 * Every game starts with a vanilla-locked profile. For the titles with an
 * online mode this is the safety valve: selecting it guarantees an unmodded
 * game folder.
 */
export function makeVanillaProfile(gameId: GameId): Profile {
  return {
    id: `${gameId}-vanilla`,
    gameId,
    name: 'Vanilla (locked)',
    order: [],
    enabled: [],
    createdAt: new Date().toISOString(),
    vanillaLock: true,
  };
}

/** Ensure the vanilla profile exists and is selected for a newly found game. */
export function ensureVanillaProfile(config: AppConfig, gameId: GameId): Profile {
  const existing = config.profiles.find((p) => p.gameId === gameId && p.vanillaLock);
  if (existing) return existing;
  const profile = makeVanillaProfile(gameId);
  config.profiles.push(profile);
  if (!config.activeProfile[gameId]) config.activeProfile[gameId] = profile.id;
  return profile;
}
