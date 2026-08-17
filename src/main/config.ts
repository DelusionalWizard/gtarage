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
      // The interface is design 2a/2b, which is a light, warm-paper direction.
      // Dark is the alternate rather than the default it used to be.
      theme: 'light',
      autoUpdate: 'notify',
      speedrunMode: false,
    },
  };
}

/**
 * Move save snapshots from an old shelf into a new one.
 *
 * Only `<game>/saves` is touched. The deploy manifest and the displaced
 * originals are deliberately left alone: the new shelf's manifest describes
 * what is actually on disk right now, and merging a stale one over it would
 * make undeploy restore the wrong files.
 */
async function mergeSnapshots(fromShelf: string, toShelf: string): Promise<void> {
  let games: string[];
  try {
    games = await fs.readdir(fromShelf);
  } catch {
    return;
  }

  for (const game of games) {
    const fromSaves = path.join(fromShelf, game, 'saves');
    if (!(await exists(fromSaves))) continue;
    const toSaves = path.join(toShelf, game, 'saves');
    await fs.mkdir(toSaves, { recursive: true });

    for (const snapshot of await fs.readdir(fromSaves)) {
      const dest = path.join(toSaves, snapshot);
      if (await exists(dest)) continue; // timestamped, so this means identical
      await fs
        .rename(path.join(fromSaves, snapshot), dest)
        .catch(async () => {
          await fs.cp(path.join(fromSaves, snapshot), dest, { recursive: true });
        });
    }
  }
}

/** True when the path is a directory with nothing in it. */
async function isEmptyDir(p: string): Promise<boolean> {
  try {
    return (await fs.readdir(p)).length === 0;
  } catch {
    return false; // not a directory, or unreadable
  }
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
    if (!(await exists(legacyDir))) return null;
    await fs.mkdir(newDir, { recursive: true });

    // Only the folders that hold real user data. Everything else in there is
    // Chromium's own cache, which is worthless and regenerates itself.
    const wanted = ['library', 'shelf', 'rigging.config.json'];
    let movedAnything = false;

    for (const entry of wanted) {
      const from = path.join(legacyDir, entry);
      if (!(await exists(from))) continue;

      const to = path.join(
        newDir,
        entry === 'rigging.config.json' ? 'swapmeet.config.json' : entry,
      );

      // A destination that exists but is empty is what a half-finished
      // migration leaves behind, so it must not block a retry.
      if (await exists(to)) {
        if (!(await isEmptyDir(to))) {
          // Save snapshots are the one thing worth merging rather than
          // skipping: they are timestamped, so they cannot collide, and
          // silently stranding someone's save backups in a folder the app no
          // longer reads is the worst outcome of a rename.
          if (entry === 'shelf') await mergeSnapshots(from, to);
          continue;
        }
        await fs.rm(to, { recursive: true, force: true });
      }

      await fs.rename(from, to).catch(async () => {
        // Across volumes, or locked: fall back to a copy.
        await fs.cp(from, to, { recursive: true });
      });
      movedAnything = true;
    }

    // Report the legacy dir whenever it still exists, not only when something
    // moved: stored paths may still point into it from an earlier partial run,
    // and the caller repoints them.
    return movedAnything || (await exists(legacyDir)) ? legacyDir : null;
  } catch (err) {
    console.error('[swapmeet] could not migrate previous data:', err);
    return null;
  }
}

/**
 * Rewrite stored absolute paths that still point at the old data folder.
 *
 * Moving the files is only half a migration. The config records absolute
 * paths — `libraryPath`, `shelfPath` and every `mod.path` — so after a rename
 * they all still point into the previous folder. The app keeps working, which
 * is what makes this dangerous: everything looks fine until that folder is
 * cleaned up and the library disappears with it.
 *
 * Returns the number of paths repointed, so startup can report it.
 */
export function repointPaths(
  config: AppConfig,
  legacyDir: string,
  newDir: string,
): number {
  const legacy = path.resolve(legacyDir).toLowerCase();
  let moved = 0;

  const repoint = (value: string): string => {
    const resolved = path.resolve(value);
    if (!resolved.toLowerCase().startsWith(legacy)) return value;
    moved += 1;
    return path.join(newDir, path.relative(legacyDir, resolved));
  };

  config.libraryPath = repoint(config.libraryPath);
  config.shelfPath = repoint(config.shelfPath);
  for (const mod of config.mods) mod.path = repoint(mod.path);

  return moved;
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

  /*
   * Retire the old theme default once.
   *
   * Every config written before the interface was rebuilt carries
   * `theme: 'dark'`, because that was the default — not because anyone chose
   * it. The interface it belonged to no longer exists, so honouring the
   * stored value would show almost every existing user a dark version of a
   * design that is light by construction. `themeChosen` records a real
   * decision, so anyone who actually picks dark keeps it from here on.
   */
  const settings = { ...base.settings, ...(loaded.settings ?? {}) };
  if (!settings.themeChosen) settings.theme = base.settings.theme;

  return {
    ...base,
    ...loaded,
    settings,
    activeProfile: { ...(loaded.activeProfile ?? {}) },
    seenBuilds: { ...(loaded.seenBuilds ?? {}) },
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
