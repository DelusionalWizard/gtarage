/**
 * Main-process implementation of the renderer API.
 *
 * Each method does its work, persists config, and returns a freshly computed
 * `AppState`. Having every mutation hand back the whole view state means the
 * renderer never has to reason about what changed -- it just re-renders. For
 * an app this size that is far cheaper than maintaining an incremental store,
 * and it makes state drift between the two processes impossible.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import { BrowserWindow, app, dialog, shell } from 'electron';

import {
  changedBuilds,
  hookVerdict,
  isBuildSensitive,
  recordBuilds,
} from '../shared/buildwatch';
import {
  countPacks,
  dlcGaps,
  needsGameconfig,
} from '../shared/dlcpacks';
import { GAMES, GAME_ORDER, getGame } from '../shared/games';
import {
  activeMods,
  buildSwapPlan,
  findConflicts,
  normaliseOrder,
  reorder,
  targetPath,
} from '../shared/planner';
import type {
  AppState,
  ApplyReport,
  BuildAlert,
  DlcReport,
  GameView,
  ImportReport,
  NexusAccount,
  SwapmeetApi,
  HookCandidateView,
  SaveSnapshotView,
  UpdateView,
  SiteEvent,
  VerifyView,
} from '../shared/api';
import { SITE_CHANNEL } from '../shared/api';
import {
  browse as runBrowse,
  catalogFiles as runCatalogFiles,
  clearStaged,
  fetchCatalogFile,
  invalidateCaches,
  stagingDir,
} from './browse';
import { promises as fs } from 'node:fs';

import { findAdoptable } from './adopt';
import { detectSpeedrunTools, launchSpeedrunTool } from './speedrun';
import { checkForUpdate, downloadUpdate, installUpdate } from './updater';
import { PRACTICE_PROFILE_NAME, SPEEDRUN_RESOURCES } from '../shared/speedrun';
import {
  SCRIPTHOOKV_URL,
  describeCandidate,
  findDownloadedHook,
  findInstalledHook,
  gamesMissingHook,
  hookCoverage,
} from './scripthook';
import { missingDependencies, scanDependencies } from './depscan';
import {
  captureGraphics,
  clearGraphics,
  graphicsStatus,
  swapGraphics,
} from './graphics';
import { listSites, openModSite } from './modsites';
import { browseEssentials } from './providers/github';
import {
  NexusAuthError,
  decryptKey,
  encryptKey,
  validateKey,
} from './providers/nexus';
import type { AppConfig, GameId, Mod, Profile, SwapPlan } from '../shared/types';
import {
  activeProfileFor,
  ensureVanillaProfile,
  findProfile,
  installFor,
  libraryFor,
  loadConfig,
  modsForGame,
  peekConfig,
  profilesForGame,
  saveConfig,
  getConfigPath,
  getConfigError,
} from './config';
import { detectGames, identifyFolder } from './detect';
import {
  deployProfile,
  isGameRunning,
  readManifest,
  runningGameProcesses,
  undeployAll,
  verifyGameFolder,
} from './deploy';
import { ensureDir, exists, freeSpace } from './fsutil';
import {
  classifyFiles,
  findBrokenMods,
  deleteModFiles,
  importMod,
  refreshMod,
  repairLayout,
} from './library';
import {
  listSnapshots,
  restoreSnapshot,
  saveFolders,
  snapshotSaves,
  type SaveSnapshot,
} from './saves';

let userDataDir = '';
let mainWindow: BrowserWindow | null = null;

/**
 * The validated Nexus account, cached in memory.
 *
 * Revalidating on every state rebuild would mean a network round trip each
 * time the user flips a toggle, so the key is checked when it is set and at
 * startup, and the answer is remembered for the session.
 */
let nexusAccount: NexusAccount | null = null;

export function initApi(dir: string, win: BrowserWindow): void {
  userDataDir = dir;
  mainWindow = win;
}

function emitProgress(done: number, total: number, label: string): void {
  mainWindow?.webContents.send('swapmeet:progress', { done, total, label });
}

// --- state ------------------------------------------------------------------

function gameViews(config: AppConfig): GameView[] {
  return GAME_ORDER.map((id) => {
    const def = GAMES[id];
    const install = installFor(config, id);
    const view: GameView = {
      id,
      name: def.name,
      shortName: def.shortName,
      era: def.era,
      notes: def.notes,
      hasOnline: def.hasOnline,
      supportedKinds: def.supportedKinds,
      installed: Boolean(install),
      modCount: modsForGame(config, id).length,
      profileCount: profilesForGame(config, id).length,
    };
    if (install) {
      view.path = install.path;
      view.source = install.source;
      if (install.version) view.version = install.version;
    }
    return view;
  });
}

/**
 * Work out whether the game updated under us, and what that broke.
 *
 * Kept next to buildState because it needs the same three things: the install
 * (for the executable version), the library (for the mods that care) and the
 * recorded build from the previous run.
 *
 * The Script Hook V half is deliberately allowed to answer "unknown". A copy
 * adopted out of a game folder is just `ScriptHookV.dll` with no build in its
 * name, and claiming a mismatch there would cry wolf on a working install.
 */
function buildAlertFor(
  config: AppConfig,
  gameId: GameId,
  mods: Mod[],
  enabled: Mod[],
): BuildAlert | null {
  const install = config.installs.find((i) => i.gameId === gameId);
  if (!install) return null;

  const [change] = changedBuilds(config.seenBuilds ?? {}, [install]);
  if (!change) return null;

  // ScriptHookVDotNet is excluded: it is a layer on top of Script Hook V and
  // carries its own unrelated version, so matching it here would compare the
  // game build against the wrong number entirely.
  const hookMod = mods.find(
    (m) => /script\s*hook\s*v/i.test(m.name) && !/\.net|dotnet|shvdn/i.test(m.name),
  );
  const hookName = hookMod ? `${hookMod.name} ${hookMod.version}` : '';
  const verdict = hookVerdict(hookName, change.current);

  return {
    gameId,
    gameName: getGame(gameId).shortName,
    previous: change.previous,
    current: change.current,
    // Only enabled mods: an unenabled ASI plugin is not something the user
    // needs to think about while working out why their game is unmodded.
    affected: enabled
      .filter((m) => isBuildSensitive(m))
      .map((m) => ({ id: m.id, name: m.name })),
    hook: {
      state: verdict.state,
      builds: verdict.builds,
      ...(hookMod ? { name: hookMod.name } : {}),
    },
  };
}

/**
 * Add-on packs the enabled mods install that nothing has listed.
 *
 * The dlclist itself normally lives inside `update.rpf`, which we cannot open,
 * so the usual answer is "unconfirmed" rather than "missing". The one case
 * where we can do better is when a mod ships its own `dlclist.xml` — plenty
 * do, precisely because the edit is such a common trip-up — in which case that
 * copy is read out of the library and used as the source of truth.
 */
async function dlcReport(
  config: AppConfig,
  gameId: GameId,
  ordered: Mod[],
): Promise<AppState['dlc']> {
  const game = getGame(gameId);
  if (!game.supportedKinds.includes('oiv') && !game.supportedKinds.includes('replace')) {
    return null;
  }

  const targetsPerMod = ordered.map((mod) => mod.files.map((f) => targetPath(mod, f)));
  const packCount = countPacks(targetsPerMod);

  // A mod that ships a dlclist is telling us what it expects to be listed.
  let xml: string | null = null;
  for (const mod of ordered) {
    const rel = mod.files.find((f) => /(^|\/)dlclist\.xml$/i.test(f));
    if (!rel) continue;
    try {
      xml = await fs.readFile(path.join(mod.path, 'content', rel), 'utf8');
      break;
    } catch {
      // Unreadable is the same as absent here: fall through to "unconfirmed".
    }
  }

  const gaps = ordered.flatMap((mod) => {
    const targets = mod.files.map((f) => targetPath(mod, f));
    return dlcGaps(targets, xml).map((gap) => ({
      modId: mod.id,
      modName: mod.name,
      ...gap,
    }));
  });

  if (gaps.length === 0 && !needsGameconfig(packCount)) return null;
  return {
    packCount,
    // `confirmed` false means we never saw a dlclist at all, so the UI must say
    // "needs an entry" rather than "the entry is missing" — on a setup where
    // the user already added it by hand, the second wording would be a lie.
    confirmed: xml !== null,
    gaps,
    needsGameconfig: needsGameconfig(packCount),
  };
}

async function buildState(config: AppConfig): Promise<AppState> {
  const gameId =
    config.lastGameId ??
    config.installs[0]?.gameId ??
    null;

  const mods = gameId ? modsForGame(config, gameId) : [];
  const profiles = gameId ? profilesForGame(config, gameId) : [];
  const profile = gameId ? activeProfileFor(config, gameId) : null;
  const ordered = profile ? activeMods(profile, mods) : [];

  let deployed: AppState['deployed'] = null;
  if (gameId) {
    const manifest = await readManifest(config, gameId);
    if (manifest) {
      const p = findProfile(config, manifest.profileId);
      deployed = {
        profileId: manifest.profileId,
        profileName: p?.name ?? 'Unknown profile',
        deployedAt: manifest.deployedAt,
        fileCount: manifest.files.length,
      };
    }
  }

  return {
    games: gameViews(config),
    currentGameId: gameId,
    mods,
    profiles,
    activeProfileId: profile?.id ?? null,
    conflicts: findConflicts(ordered),
    deployed,
    settings: config.settings,
    libraryPath: config.libraryPath,
    shelfPath: config.shelfPath,
    activeBytes: ordered.reduce((sum, m) => sum + m.size, 0),
    // Only report gaps for mods the user has actually switched on: an
    // unenabled mod's missing script hook is not a problem yet.
    missingDeps: ordered
      .map((mod) => ({
        modId: mod.id,
        modName: mod.name,
        deps: missingDependencies(mod, mods),
      }))
      .filter((entry) => entry.deps.length > 0),
    brokenMods: (
      await findBrokenMods((m) => libraryFor(config, m.gameId), mods)
    ).map(({ mod, missing }) => ({ id: mod.id, name: mod.name, missing })),
    ...(gameId
      ? (() => {
          const alert = buildAlertFor(config, gameId, mods, ordered);
          return alert ? { buildAlert: alert } : {};
        })()
      : {}),
    dlc: gameId ? await dlcReport(config, gameId, ordered) : null,
    appVersion: app.getVersion(),
    nexus: nexusAccount,
    hasNexusKey: Boolean(config.nexusApiKey),
    // Surfaced so the UI can warn rather than silently looking freshly
    // installed to someone who had a library a minute ago.
    ...(getConfigError() ? { configError: getConfigError()! } : {}),
  };
}

function emitSite(event: SiteEvent): void {
  mainWindow?.webContents.send(SITE_CHANNEL, event);
}

/**
 * Validate a stored key once at startup, so the browser tab can show the
 * account straight away instead of after the first query.
 */
export async function primeNexus(): Promise<void> {
  const config = await loadConfig(userDataDir);
  const key = decryptKey(config.nexusApiKey);
  if (!key) return;
  try {
    nexusAccount = await validateKey(key);
  } catch {
    nexusAccount = null;
  }
}

/**
 * Import a file the embedded browser captured.
 *
 * Shared by the site-browser hook and the in-app download path so both end up
 * in the library through exactly one code path.
 */
async function importStagedFile(
  filePath: string,
  gameId: GameId,
): Promise<{ imported: boolean; message: string; modId?: string }> {
  const result = await handlers.importPaths(gameId, [filePath]);
  const first = result.report.imported[0];
  const failure = result.report.failed[0];

  if (first) {
    await clearStaged(filePath);
    return {
      imported: true,
      modId: first.id,
      message: `${first.name} added to the library as a "${first.kind}" mod.`,
    };
  }
  return {
    imported: false,
    message: failure
      ? `${path.basename(filePath)} could not be imported: ${failure.error}`
      : `${path.basename(filePath)} could not be imported.`,
  };
}

/** Wire the embedded browser's download capture into the library. */
export function modSiteHooks() {
  return {
    stagingDir(gameId: GameId): string {
      return stagingDir(peekConfig(), gameId);
    },
    onProgress(fileName: string, received: number, total: number): void {
      emitSite({ kind: 'progress', fileName, message: 'Downloading', received, total });
    },
    onComplete(capture: {
      filePath: string;
      fileName: string;
      gameId: GameId;
      executable: boolean;
    }): void {
      if (capture.executable) {
        // Installers are never imported or run. They are left in the staging
        // folder for the user to deal with deliberately.
        emitSite({
          kind: 'staged',
          fileName: capture.fileName,
          message: `${capture.fileName} is an installer, so Swapmeet saved it without importing or running it. Open the downloads folder to use it.`,
        });
        return;
      }
      void importStagedFile(capture.filePath, capture.gameId).then(async (outcome) => {
        emitSite({
          kind: outcome.imported ? 'imported' : 'failed',
          fileName: capture.fileName,
          message: outcome.message,
        });
      });
    },
    onFailed(fileName: string, reason: string): void {
      emitSite({ kind: 'failed', fileName, message: `${fileName} download ${reason}.` });
    },
  };
}


async function state(): Promise<AppState> {
  return buildState(await loadConfig(userDataDir));
}

async function mutate(fn: (config: AppConfig) => void | Promise<void>): Promise<AppState> {
  const config = await loadConfig(userDataDir);
  await fn(config);
  await saveConfig(config);
  return buildState(config);
}

/** Resolve a profile or fail loudly: a missing profile is always a bug. */
function requireProfile(config: AppConfig, profileId: string): Profile {
  const profile = findProfile(config, profileId);
  if (!profile) throw new Error(`No profile with id ${profileId}.`);
  return profile;
}

/**
 * Refuse to touch the game folder while the game is running.
 *
 * Every operation that writes there must call this, not just "apply". The
 * guard originally lived only in `applyProfile`, which left `removeMod`,
 * `undeployAll`, `adopt` and `installHook` free to delete files out from
 * under a live game — and Windows does not permit that, so it surfaced as a
 * raw `EPERM: operation not permitted, unlink ...` after the operation had
 * already half-run. A partially undeployed install is a genuinely bad state:
 * some mod files gone, some still there, and a manifest that no longer
 * describes either.
 */
async function assertGameNotRunning(config: AppConfig, gameId: GameId): Promise<void> {
  if (!config.settings.blockWhileGameRunning) return;
  if (!(await isGameRunning(gameId))) return;

  const running = await runningGameProcesses(gameId);
  throw new Error(
    `${getGame(gameId).shortName} is running${running.length ? ` (${running.join(', ')})` : ''}. ` +
      'Close the game first — Windows will not let its files be changed while it has them open.',
  );
}

function requireInstall(config: AppConfig, gameId: GameId): string {
  const install = installFor(config, gameId);
  if (!install) throw new Error(`${getGame(gameId).shortName} is not set up yet.`);
  return install.path;
}

// --- implementation ---------------------------------------------------------

export const handlers: SwapmeetApi = {
  async getState() {
    return state();
  },

  /**
   * Accept the new build, clearing the alert.
   *
   * Recording happens here and nowhere else. The obvious alternative — record
   * whatever we detect, at detection time — destroys the feature: the very
   * first state refresh would overwrite the previous build and the alert would
   * never be shown to anyone. The recorded build has to mean "the last build
   * the user was told about", not "the last build we saw".
   */
  async acknowledgeBuild(gameId) {
    return mutate((config) => {
      const install = config.installs.find((i) => i.gameId === gameId);
      if (!install) return;
      config.seenBuilds = recordBuilds(config.seenBuilds ?? {}, [install]);
    });
  },

  async setFileExcluded({ profileId, modId, file, excluded }) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      const map = profile.excludedFiles ?? (profile.excludedFiles = {});
      const current = new Set(map[modId] ?? []);
      if (excluded) current.add(file);
      else current.delete(file);
      // Drop the key entirely when nothing is excluded, so a profile that has
      // been toggled back and forth does not accumulate empty arrays in the
      // config file forever.
      if (current.size === 0) delete map[modId];
      else map[modId] = [...current];
    });
  },

  async selectGame(gameId) {
    return mutate((config) => {
      config.lastGameId = gameId;
      ensureVanillaProfile(config, gameId);
    });
  },

  async detectGames() {
    const found = await detectGames();
    return mutate((config) => {
      for (const install of found) {
        const existing = config.installs.findIndex((i) => i.gameId === install.gameId);
        // A manually chosen path outranks anything detection guesses.
        if (existing >= 0) {
          if (config.installs[existing]!.source === 'manual') continue;
          config.installs[existing] = install;
        } else {
          config.installs.push(install);
        }
        ensureVanillaProfile(config, install.gameId);
      }
      if (!config.lastGameId && config.installs[0]) {
        config.lastGameId = config.installs[0].gameId;
      }
    });
  },

  async browseForGame(gameId) {
    const result = await dialog.showOpenDialog({
      title: `Locate ${getGame(gameId).name}`,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return state();
    const dir = result.filePaths[0];

    const matches = await identifyFolder(dir);
    if (!matches.includes(gameId)) {
      const label = matches.length
        ? `That folder looks like ${getGame(matches[0]!).name}.`
        : 'That folder does not contain a recognised Grand Theft Auto install.';
      throw new Error(`${label} Pick the folder containing the game executable.`);
    }

    return mutate((config) => {
      const install = { gameId, path: dir, source: 'manual' as const };
      const idx = config.installs.findIndex((i) => i.gameId === gameId);
      if (idx >= 0) config.installs[idx] = install;
      else config.installs.push(install);
      config.lastGameId = gameId;
      ensureVanillaProfile(config, gameId);
    });
  },

  async forgetGame(gameId) {
    return mutate((config) => {
      config.installs = config.installs.filter((i) => i.gameId !== gameId);
    });
  },

  async importMods(gameId, mode) {
    // Windows refuses to combine openFile and openDirectory in one dialog --
    // it silently honours only the first -- so the two are separate actions.
    const result = await dialog.showOpenDialog({
      title:
        mode === 'folder'
          ? `Add a mod folder to ${getGame(gameId).shortName}`
          : `Add mod files to ${getGame(gameId).shortName}`,
      properties:
        mode === 'folder'
          ? ['openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections'],
      filters:
        mode === 'folder'
          ? []
          : [
              {
                name: 'Mods and archives',
                extensions: [
                  'zip', 'oiv', 'rar', '7z',
                  'asi', 'dll', 'pak', 'ucas', 'utoc',
                  'cs', 'cm', 'lua', 'xml', 'meta', 'rpf', 'ytd', 'yft', 'ydr',
                ],
              },
              { name: 'All files', extensions: ['*'] },
            ],
    });
    if (result.canceled) return { state: await state(), report: { imported: [], failed: [] } };
    return handlers.importPaths(gameId, result.filePaths);
  },

  async importPaths(gameId, paths) {
    const config = await loadConfig(userDataDir);
    const libraryRoot = libraryFor(config, gameId);
    await ensureDir(libraryRoot);

    const report: ImportReport = { imported: [], failed: [] };
    const existingIds = new Set(config.mods.map((m) => m.id));

    for (const source of paths) {
      try {
        const { mod, notes } = await importMod(source, gameId, libraryRoot, existingIds);
        existingIds.add(mod.id);
        config.mods.push(mod);

        // A newly imported mod joins every profile's order, switched off,
        // except core mods which are enabled and pinned to the top.
        for (const profile of profilesForGame(config, gameId)) {
          if (profile.vanillaLock) continue;
          profile.order.push(mod.id);
          if (mod.core) {
            profile.enabled.push(mod.id);
            profile.order = normaliseOrder(profile.order, config.mods);
          }
        }

        report.imported.push({ id: mod.id, name: mod.name, kind: mod.kind, notes });
      } catch (err) {
        report.failed.push({ source, error: (err as Error).message });
      }
    }

    await saveConfig(config);
    return { state: await buildState(config), report };
  },

  async removeMod(modId) {
    const config = await loadConfig(userDataDir);
    const mod = config.mods.find((m) => m.id === modId);
    if (!mod) return buildState(config);

    // If the mod is currently deployed, take it out of the game folder first.
    const manifest = await readManifest(config, mod.gameId);
    if (manifest?.files.some((f) => f.modId === modId)) {
      await assertGameNotRunning(config, mod.gameId);
      const gamePath = requireInstall(config, mod.gameId);
      const profile = activeProfileFor(config, mod.gameId);
      if (profile) {
        profile.enabled = profile.enabled.filter((id) => id !== modId);
        await deployProfile(config, mod.gameId, gamePath, profile, config.mods, emitProgress);
      }
    }

    await deleteModFiles(libraryFor(config, mod.gameId), mod);
    config.mods = config.mods.filter((m) => m.id !== modId);
    for (const profile of config.profiles) {
      profile.order = profile.order.filter((id) => id !== modId);
      profile.enabled = profile.enabled.filter((id) => id !== modId);
    }
    await saveConfig(config);
    return buildState(config);
  },

  async updateMod(modId, patch) {
    return mutate((config) => {
      const mod = config.mods.find((m) => m.id === modId);
      if (mod) Object.assign(mod, patch);
    });
  },

  async toggleMod(profileId, modId, enabled) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      if (profile.vanillaLock) {
        throw new Error('The vanilla-locked profile cannot have mods enabled. Create a new profile instead.');
      }
      const set = new Set(profile.enabled);
      if (enabled) set.add(modId);
      else set.delete(modId);
      profile.enabled = profile.order.filter((id) => set.has(id));
    });
  },

  async moveMod(profileId, modId, toIndex) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      profile.order = reorder(profile.order, modId, toIndex);
      profile.enabled = profile.order.filter((id) => profile.enabled.includes(id));
    });
  },

  async tidyOrder(profileId) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      profile.order = normaliseOrder(profile.order, config.mods);
      profile.enabled = profile.order.filter((id) => profile.enabled.includes(id));
    });
  },

  async createProfile(gameId, name, copyFromId) {
    return mutate((config) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Give the profile a name.');
      if (profilesForGame(config, gameId).some((p) => p.name === trimmed)) {
        throw new Error(`A profile called "${trimmed}" already exists.`);
      }
      const source = copyFromId ? findProfile(config, copyFromId) : null;
      const profile: Profile = {
        id: `${gameId}-${Date.now().toString(36)}`,
        gameId,
        name: trimmed,
        order: source ? [...source.order] : modsForGame(config, gameId).map((m) => m.id),
        enabled: source && !source.vanillaLock ? [...source.enabled] : [],
        createdAt: new Date().toISOString(),
        vanillaLock: false,
      };
      config.profiles.push(profile);
      config.activeProfile[gameId] = profile.id;
    });
  },

  async renameProfile(profileId, name) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Give the profile a name.');
      profile.name = trimmed;
    });
  },

  async deleteProfile(profileId) {
    return mutate((config) => {
      const profile = requireProfile(config, profileId);
      if (profile.vanillaLock) {
        throw new Error('The vanilla-locked profile is the safety net and cannot be deleted.');
      }
      config.profiles = config.profiles.filter((p) => p.id !== profileId);
      if (config.activeProfile[profile.gameId] === profileId) {
        const fallback = profilesForGame(config, profile.gameId)[0];
        if (fallback) config.activeProfile[profile.gameId] = fallback.id;
        else delete config.activeProfile[profile.gameId];
      }
    });
  },

  async setActiveProfile(gameId, profileId) {
    return mutate((config) => {
      requireProfile(config, profileId);
      config.activeProfile[gameId] = profileId;
      config.lastGameId = gameId;
    });
  },

  async planSwap(profileId): Promise<SwapPlan> {
    const config = await loadConfig(userDataDir);
    const profile = requireProfile(config, profileId);
    const gamePath = requireInstall(config, profile.gameId);
    const manifest = await readManifest(config, profile.gameId);
    const from = manifest ? findProfile(config, manifest.profileId) : null;

    return buildSwapPlan({
      gameId: profile.gameId,
      from,
      to: profile,
      mods: modsForGame(config, profile.gameId),
      manifest,
      freeBytes: await freeSpace(gamePath),
      gameRunning: config.settings.blockWhileGameRunning
        ? await isGameRunning(profile.gameId)
        : false,
      runningProcesses: config.settings.blockWhileGameRunning
        ? await runningGameProcesses(profile.gameId)
        : [],
      warnAboutOnline: config.settings.warnAboutOnline,
    });
  },

  async applyProfile(profileId) {
    const config = await loadConfig(userDataDir);
    const profile = requireProfile(config, profileId);
    const gameId = profile.gameId;
    const gamePath = requireInstall(config, gameId);

    await assertGameNotRunning(config, gameId);

    if (config.settings.backupSavesOnSwap) {
      await snapshotSaves(config, gameId, `before ${profile.name}`);
    }

    // Read before deploying: deployProfile replaces the manifest, and we need
    // to know which profile was live in order to capture its settings.
    const previousManifest = await readManifest(config, gameId);

    const result = await deployProfile(
      config,
      gameId,
      gamePath,
      profile,
      config.mods,
      emitProgress,
    );

    // Settings travel with the profile: capture what the outgoing profile is
    // currently using, then restore what this one was last saved with. Done
    // after the files move, so a restored commandline.txt is not treated as a
    // displaced game file by the deploy diff.
    let graphics = { captured: 0, restored: 0 };
    if (config.settings.graphicsPerProfile) {
      const previousProfileId = previousManifest?.profileId ?? null;
      graphics = await swapGraphics(config, gameId, previousProfileId, profile.id, gamePath);
    }

    config.activeProfile[gameId] = profile.id;
    profile.lastLaunchedAt = new Date().toISOString();
    await saveConfig(config);

    const report: ApplyReport = {
      added: result.added,
      removed: result.removed,
      kept: result.kept,
      problems: result.problems,
      graphicsCaptured: graphics.captured,
      graphicsRestored: graphics.restored,
    };
    return { state: await buildState(config), report };
  },

  async undeployAll(gameId) {
    const config = await loadConfig(userDataDir);
    await assertGameNotRunning(config, gameId);
    const gamePath = requireInstall(config, gameId);
    const problems = await undeployAll(config, gameId, gamePath, emitProgress);
    const vanilla = ensureVanillaProfile(config, gameId);
    config.activeProfile[gameId] = vanilla.id;
    await saveConfig(config);
    return { state: await buildState(config), problems };
  },

  async verify(gameId): Promise<VerifyView> {
    const config = await loadConfig(userDataDir);
    const gamePath = requireInstall(config, gameId);
    const report = await verifyGameFolder(config, gameId, gamePath);
    return { clean: report.clean, missing: report.missing, orphans: report.orphans };
  },

  async scanAdoptable(gameId) {
    const config = await loadConfig(userDataDir);
    const install = installFor(config, gameId);
    if (!install) return [];
    return findAdoptable(config, gameId, install.path);
  },

  async adopt(gameId, groupId) {
    const config = await loadConfig(userDataDir);
    const gamePath = requireInstall(config, gameId);
    const group = (await findAdoptable(config, gameId, gamePath)).find((g) => g.id === groupId);
    if (!group) throw new Error('Those files are no longer in the game folder.');

    /*
     * Copy the files into a staging folder that mirrors their game-relative
     * layout, then hand it to the normal importer. Going through the same
     * path as a dragged-in folder means an adopted mod is indistinguishable
     * from an imported one afterwards -- same classification, same dependency
     * scan, same removal.
     *
     * The originals are left in place. The next Apply sees them, shelves them
     * as displaced, and links the library copy over the top, so undeploying
     * puts the user's own files back exactly as they were.
     */
    const staging = path.join(stagingDir(config, gameId), `adopt-${groupId}`);
    await fs.rm(staging, { recursive: true, force: true });
    for (const rel of group.files) {
      const from = path.join(gamePath, rel);
      const to = path.join(staging, rel);
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
    }

    const result = await handlers.importPaths(gameId, [staging]);
    await fs.rm(staging, { recursive: true, force: true });

    const imported = result.report.imported[0];
    if (!imported) {
      const failure = result.report.failed[0];
      throw new Error(failure?.error ?? 'Those files could not be imported.');
    }

    // Give it the recognised name rather than the staging folder's, and turn
    // it on: these files are already active in the game folder, so leaving it
    // disabled would misrepresent the current state.
    const next = await mutate((cfg) => {
      const mod = cfg.mods.find((m) => m.id === imported.id);
      if (mod) {
        mod.name = group.name;
        mod.core = group.core;
      }
      const profile = activeProfileFor(cfg, gameId);
      if (profile && !profile.vanillaLock && !profile.enabled.includes(imported.id)) {
        profile.enabled.push(imported.id);
        profile.order = normaliseOrder(profile.order, cfg.mods);
        profile.enabled = profile.order.filter((id) => profile.enabled.includes(id));
      }
    });

    return {
      state: next,
      message: `${group.name} imported into the library from your game folder and switched on. Your original files are untouched until you apply a profile.`,
    };
  },

  async checkForUpdate() {
    const info = await checkForUpdate();
    const view: UpdateView = {
      version: info.version,
      current: info.current,
      newer: info.newer,
      url: info.url,
      notes: info.notes,
      verifiable: Boolean(info.sha512),
    };
    if (info.assetName) view.assetName = info.assetName;
    if (info.sizeBytes) view.sizeBytes = info.sizeBytes;
    if (info.cannotSelfUpdate) view.cannotSelfUpdate = true;
    return view;
  },

  async installUpdate() {
    const config = await loadConfig(userDataDir);
    const info = await checkForUpdate();

    if (!info.newer) {
      return { started: false, message: 'Swapmeet is already up to date.' };
    }
    if (info.cannotSelfUpdate) {
      await shell.openExternal(info.url);
      return {
        started: false,
        message:
          'The portable build cannot replace itself. The releases page is open — download the new portable exe and swap it in.',
      };
    }

    /*
     * Never restart out from under a live game or a half-applied profile.
     *
     * Quitting mid-deploy would leave the game folder in a state the manifest
     * does not describe, which is the one outcome this app exists to prevent.
     */
    for (const install of config.installs) {
      if (await isGameRunning(install.gameId)) {
        return {
          started: false,
          message: `${getGame(install.gameId).shortName} is running. Close it before updating, so nothing is half-applied.`,
        };
      }
    }

    const dir = path.join(config.shelfPath, 'updates');
    const file = await downloadUpdate(info, dir, (received, total) =>
      emitProgress(received, total, `Downloading Swapmeet ${info.version}`),
    );

    installUpdate(file);
    return {
      started: true,
      message: `Installing Swapmeet ${info.version}. Swapmeet will close.`,
    };
  },

  async speedrunTools(gameId) {
    const config = await loadConfig(userDataDir);
    return detectSpeedrunTools(gameId, config.settings.speedrunToolPaths ?? {});
  },

  async launchSpeedrunTool(toolId, gameId) {
    const config = await loadConfig(userDataDir);
    await launchSpeedrunTool(toolId, gameId, config.settings.speedrunToolPaths ?? {});
  },

  async locateSpeedrunTool(toolId, gameId) {
    const result = await dialog.showOpenDialog({
      title: 'Find the program',
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      const config = await loadConfig(userDataDir);
      return detectSpeedrunTools(gameId, config.settings.speedrunToolPaths ?? {});
    }

    // Remembered per tool: portable programs move around, and re-asking every
    // launch would be worse than not offering it at all.
    const chosen = result.filePaths[0];
    await mutate((cfg) => {
      cfg.settings.speedrunToolPaths = {
        ...(cfg.settings.speedrunToolPaths ?? {}),
        [toolId]: chosen,
      };
    });

    const config = await loadConfig(userDataDir);
    return detectSpeedrunTools(gameId, config.settings.speedrunToolPaths ?? {});
  },

  async speedrunResources() {
    return SPEEDRUN_RESOURCES;
  },

  async hookStatus() {
    const config = await loadConfig(userDataDir);
    const found = [
      ...(await findInstalledHook(config)),
      ...(await findDownloadedHook()),
    ];

    const candidates: HookCandidateView[] = [];
    for (const candidate of found) {
      const view: HookCandidateView = {
        path: candidate.path,
        gameId: candidate.gameId,
        source: candidate.source,
        modifiedAt: candidate.modifiedAt,
        contents: await describeCandidate(candidate),
      };
      if (candidate.version) view.version = candidate.version;
      candidates.push(view);
    }

    const coverage = hookCoverage(config);
    return {
      missingFor: coverage.missing,
      presentFor: coverage.present,
      candidates,
      url: SCRIPTHOOKV_URL,
    };
  },

  async installHook(sourcePath, gameIds) {
    if (gameIds.length === 0) throw new Error('No game chosen.');

    /*
     * When the copy lives in a game folder, take only ScriptHookV's own
     * files. Passing the folder itself made the importer copy the entire
     * ~100 GB game install into the library, which presented as the app
     * hanging on "Setting up ScriptHookV...".
     */
    const config0 = await loadConfig(userDataDir);
    const candidate = [
      ...(await findInstalledHook(config0)),
      ...(await findDownloadedHook()),
    ].find((c) => c.path === sourcePath);

    let payload = sourcePath;
    let staged: string | null = null;

    if (candidate?.files?.length) {
      staged = path.join(stagingDir(config0, gameIds[0]!), 'scripthookv-from-game');
      await fs.rm(staged, { recursive: true, force: true });
      await ensureDir(staged);
      for (const name of candidate.files) {
        await fs.copyFile(path.join(sourcePath, name), path.join(staged, name));
      }
      payload = staged;
    }

    const installedFor: GameId[] = [];
    const failures: string[] = [];

    /*
     * Imported once per game rather than once overall.
     *
     * Legacy and Enhanced keep separate libraries, and their builds are not
     * interchangeable, so a copy is only installed into a game whose build it
     * actually is. The caller has already narrowed the list.
     */
    for (const gameId of gameIds) {
      try {
        const result = await handlers.importPaths(gameId, [payload]);
        const imported = result.report.imported[0];
        if (!imported) {
          failures.push(result.report.failed[0]?.error ?? 'import failed');
          continue;
        }

        await mutate((cfg) => {
          const mod = cfg.mods.find((m) => m.id === imported.id);
          if (mod) {
            mod.name = 'ScriptHookV';
            mod.core = true;
          }
          // Switch it on: it is a prerequisite, so an installed-but-disabled
          // ScriptHookV is never what anyone wanted.
          const profile = activeProfileFor(cfg, gameId);
          if (profile && !profile.vanillaLock && !profile.enabled.includes(imported.id)) {
            profile.enabled.push(imported.id);
            profile.order = normaliseOrder(profile.order, cfg.mods);
            profile.enabled = profile.order.filter((id) => profile.enabled.includes(id));
          }
        });
        installedFor.push(gameId);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }

    if (installedFor.length === 0) {
      throw new Error(failures[0] ?? 'ScriptHookV could not be installed.');
    }

    if (staged) await fs.rm(staged, { recursive: true, force: true });

    const names = installedFor.map((id) => getGame(id).shortName).join(' and ');
    return {
      state: await state(),
      installedFor,
      message:
        `ScriptHookV added to your library for ${names} and switched on. ` +
        'Apply the profile to install it into the game folder.',
    };
  },

  async graphicsFor(profileId) {
    const config = await loadConfig(userDataDir);
    const profile = requireProfile(config, profileId);
    const install = installFor(config, profile.gameId);
    return graphicsStatus(config, profile.gameId, profileId, install?.path ?? null);
  },

  async captureGraphics(profileId) {
    const config = await loadConfig(userDataDir);
    const profile = requireProfile(config, profileId);
    const install = installFor(config, profile.gameId);
    const count = await captureGraphics(
      config,
      profile.gameId,
      profileId,
      install?.path ?? null,
    );
    return { state: await state(), count };
  },

  async clearGraphics(profileId) {
    const config = await loadConfig(userDataDir);
    const profile = requireProfile(config, profileId);
    await clearGraphics(config, profile.gameId, profileId);
    return state();
  },

  async listSaves(gameId) {
    const config = await loadConfig(userDataDir);
    return (await listSnapshots(config, gameId)).map(toSaveView);
  },

  async backupSaves(gameId, label) {
    const config = await loadConfig(userDataDir);
    await snapshotSaves(config, gameId, label || 'manual backup');
    return (await listSnapshots(config, gameId)).map(toSaveView);
  },

  async restoreSave(gameId, snapshotId) {
    const config = await loadConfig(userDataDir);
    await restoreSnapshot(config, gameId, snapshotId);
    return (await listSnapshots(config, gameId)).map(toSaveView);
  },

  async launchGame(gameId) {
    const config = await loadConfig(userDataDir);
    const gamePath = requireInstall(config, gameId);
    const install = installFor(config, gameId);
    const def = getGame(gameId);

    /*
     * Starting the game is not simply "run the .exe".
     *
     * The HD-era titles check how they were started and bail out with
     * ERR_NO_LAUNCHER if the main binary is run directly. When the copy came
     * from Steam, handing Steam its own URL is the most reliable route: it
     * runs the Rockstar launcher chain exactly as a normal launch would.
     * Otherwise fall back to the launcher shims, in `launchWith` order.
     */
    const steamAppId = def.steamAppIds[0];
    if (install?.source === 'steam' && steamAppId) {
      try {
        await shell.openExternal(`steam://rungameid/${steamAppId}`);
        return { ok: true };
      } catch {
        // Steam may not be installed any more; fall through to the exes.
      }
    }

    const order = def.launchWith ?? def.executables;
    for (const exe of order) {
      const full = path.join(gamePath, exe);
      if (!(await exists(full))) continue;
      try {
        // detached + unref so closing Swapmeet does not kill the game.
        const child = execFile(full, { cwd: path.dirname(full) });
        child.unref();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    return { ok: false, error: `Could not find a way to start ${def.shortName}.` };
  },

  async openPath(which, gameId) {
    const config = await loadConfig(userDataDir);
    let target: string;
    switch (which) {
      case 'game':
        if (!gameId) throw new Error('No game selected.');
        target = requireInstall(config, gameId);
        break;
      case 'library':
        target = gameId ? libraryFor(config, gameId) : config.libraryPath;
        break;
      case 'saves': {
        if (!gameId) throw new Error('No game selected.');
        // The game's own save folder, not Swapmeet's snapshots of it.
        const folders = await saveFolders(gameId);
        const first = folders[0];
        if (!first) {
          throw new Error(
            `${getGame(gameId).shortName} has not created a save folder yet. Launch the game once first.`,
          );
        }
        target = first;
        break;
      }
      case 'shelf':
        target = config.shelfPath;
        break;
      case 'config':
        target = path.dirname(getConfigPath());
        break;
    }
    await ensureDir(target);
    await shell.openPath(target);
  },

  async updateSettings(patch) {
    return mutate((config) => {
      config.settings = { ...config.settings, ...patch };
    });
  },

  // --- mod browser ---------------------------------------------------------

  async browse(query) {
    const config = await loadConfig(userDataDir);
    return runBrowse(config, query, modsForGame(config, query.gameId));
  },

  async catalogFiles(mod, gameId) {
    const config = await loadConfig(userDataDir);
    return runCatalogFiles(config, mod, gameId);
  },

  async installCatalogFile(mod, file, gameId) {
    const config = await loadConfig(userDataDir);

    if (mod.manualOnly) {
      throw new Error(
        mod.manualReason ?? 'This mod has to be downloaded from its own site.',
      );
    }

    let fetched;
    try {
      fetched = await fetchCatalogFile(config, gameId, mod, file, (received, total) => {
        emitProgress(received, total || file.size, `Downloading ${file.name}`);
      });
    } catch (err) {
      if (err instanceof NexusAuthError) {
        // Not a failure so much as a different route: send them to the page,
        // where the site's own download button hands back over nxm://.
        await shell.openExternal(mod.url);
        throw new Error(err.message);
      }
      throw err;
    }

    if (fetched.executable) {
      return {
        state: await state(),
        imported: false,
        message: `${fetched.fileName} is an installer. Swapmeet saved it to the downloads folder but will not run it — install it yourself, then import what it produces.`,
      };
    }

    const outcome = await importStagedFile(fetched.filePath, gameId);

    // The provider knows the real name and version; the importer can only
    // guess them from a filename, which yields things like "1.0" for a
    // release actually tagged v9.7.3. Prefer the catalog's answer.
    if (outcome.imported && outcome.modId) {
      await mutate((cfg) => {
        const imported = cfg.mods.find((m) => m.id === outcome.modId);
        if (!imported) return;
        imported.name = mod.name;
        imported.version = mod.version.replace(/^v/i, '');
        imported.source = mod.url;
      });
    }

    return { state: await state(), imported: outcome.imported, message: outcome.message };
  },

  async refreshCatalog() {
    invalidateCaches();
  },

  async installDependency(essentialId, gameId) {
    const catalog = await browseEssentials(gameId, '');
    const mod = catalog.find((m) => m.id === essentialId);
    if (!mod) {
      throw new Error('Swapmeet does not know how to fetch that prerequisite automatically.');
    }
    if (mod.manualOnly) {
      await shell.openExternal(mod.url);
      return {
        state: await state(),
        imported: false,
        message: `${mod.name} ${mod.manualReason ?? 'must be downloaded from its own site.'} The page is open in your browser — drag the file back here when you have it.`,
      };
    }
    const file = mod.files.find((f) => f.primary) ?? mod.files[0];
    if (!file) throw new Error(`${mod.name} has no downloadable file right now.`);
    return handlers.installCatalogFile(mod, file, gameId);
  },

  async rescanDependencies(gameId) {
    const config = await loadConfig(userDataDir);
    // A full re-read: file list, classification and prerequisites. The
    // startup repair only re-runs the classification rules over stored data;
    // this one goes back to the disk, so it also picks up files added or
    // removed by hand inside the library.
    for (const mod of modsForGame(config, gameId)) {
      // Hoist anything imported under older unwrap rules before re-reading it.
      await repairLayout(mod);
      const refreshed = await refreshMod(mod);
      mod.files = refreshed.files;
      mod.size = refreshed.size;
      mod.kind = classifyFiles(mod.files, gameId);
      mod.dependencies = await scanDependencies(mod.path, mod.files, gameId);
    }
    await saveConfig(config);
    return buildState(config);
  },

  async listSites(gameId) {
    return listSites(gameId);
  },

  async openSite(siteId, gameId) {
    openModSite(siteId, gameId);
  },

  async openExternal(url) {
    // Only ever hand the OS an http(s) URL: `shell.openExternal` will happily
    // launch other protocol handlers, which is a way to run things.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing to open a ${parsed.protocol} link.`);
    }
    await shell.openExternal(parsed.toString());
  },

  async setNexusKey(apiKey) {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('Paste your Nexus personal API key first.');

    try {
      const account = await validateKey(trimmed);
      nexusAccount = account;
      const next = await mutate((config) => {
        config.nexusApiKey = encryptKey(trimmed);
      });
      return { state: next, account };
    } catch (err) {
      nexusAccount = null;
      return { state: await state(), account: null, error: (err as Error).message };
    }
  },

  async clearNexusKey() {
    nexusAccount = null;
    return mutate((config) => {
      delete config.nexusApiKey;
    });
  },

  async windowMinimize() {
    mainWindow?.minimize();
  },

  async windowMaximize() {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  },

  async windowClose() {
    mainWindow?.close();
  },
};

function toSaveView(s: SaveSnapshot): SaveSnapshotView {
  const view: SaveSnapshotView = {
    id: s.id,
    createdAt: s.createdAt,
    label: s.label,
    size: s.size,
    fileCount: s.fileCount,
  };
  if (s.savedAt) view.savedAt = s.savedAt;
  return view;
}

/** Mods for a game, exported for tests. */
export function modsOf(config: AppConfig, gameId: GameId): Mod[] {
  return modsForGame(config, gameId);
}

export { app };
