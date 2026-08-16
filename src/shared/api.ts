/**
 * The contract between the renderer and the main process.
 *
 * The renderer has no Node access at all: `contextIsolation` is on,
 * `nodeIntegration` is off, and everything it can do is one of the methods
 * below, exposed through a preload bridge. Keeping the surface small and
 * explicit is what stops a mod manager -- an app whose whole job is writing
 * files -- from becoming a remote-code-execution hazard.
 */

import type {
  BrowseQuery,
  BrowseResult,
  CatalogFile,
  CatalogMod,
} from './catalog';
import type { ModSite } from './sites';
import type {
  AppConfig,
  Conflict,
  GameId,
  Mod,
  ModDependency,
  ModKind,
  Profile,
  SwapPlan,
} from './types';

/** One channel carries every call, dispatched by method name. */
export const CALL_CHANNEL = 'swapmeet:call';
/** Main -> renderer progress during a long deploy. */
export const PROGRESS_CHANNEL = 'swapmeet:progress';
/** Main -> renderer notifications from the embedded mod-site browser. */
export const SITE_CHANNEL = 'swapmeet:site';

/** Nexus account state, so the UI can say what the key can actually do. */
export interface NexusAccount {
  name: string;
  premium: boolean;
  supporter: boolean;
}

/** A library mod together with the prerequisites it is still missing. */
export interface MissingDeps {
  modId: string;
  modName: string;
  deps: ModDependency[];
}

/** Pushed to the renderer when the embedded browser captures a download. */
export interface SiteEvent {
  kind: 'progress' | 'imported' | 'staged' | 'failed';
  fileName: string;
  message: string;
  received?: number;
  total?: number;
}

export interface GameView {
  id: GameId;
  name: string;
  shortName: string;
  era: '3d' | 'hd' | 'de';
  notes: string;
  hasOnline: boolean;
  supportedKinds: ModKind[];
  installed: boolean;
  path?: string;
  version?: string;
  source?: string;
  modCount: number;
  profileCount: number;
}

/** What is currently laid down in the game folder. */
export interface DeployedView {
  profileId: string;
  profileName: string;
  deployedAt: string;
  fileCount: number;
}

/** Everything the UI renders, recomputed after every mutation. */
export interface AppState {
  games: GameView[];
  currentGameId: GameId | null;
  mods: Mod[];
  profiles: Profile[];
  activeProfileId: string | null;
  conflicts: Conflict[];
  deployed: DeployedView | null;
  settings: AppConfig['settings'];
  libraryPath: string;
  shelfPath: string;
  /** Total bytes used by the current game's enabled mods. */
  activeBytes: number;
  /** Enabled mods whose detected prerequisites are not in the library. */
  missingDeps: MissingDeps[];
  /**
   * Mods whose files have disappeared from the library.
   *
   * Surfaced so the user is told once, with a repair action, rather than
   * discovering it as a wall of per-file errors on the next apply.
   */
  brokenMods: Array<{ id: string; name: string; missing: number }>;
  /**
   * The running app version.
   *
   * Comes from the app rather than being written into the HTML, because a
   * hardcoded one silently drifts every time the version is bumped — it had
   * already fallen two releases behind.
   */
  appVersion: string;
  /** Nexus account, when a working API key is configured. */
  nexus: NexusAccount | null;
  /** Whether a Nexus key is stored at all (it is never sent to the UI). */
  hasNexusKey: boolean;
  /**
   * Set when the settings file on disk could not be read and the app fell back
   * to defaults. The damaged file is preserved rather than overwritten, and the
   * user needs telling before they rebuild profiles they may still have.
   */
  configError?: { message: string; backupPath: string };
}

export interface ImportReport {
  imported: Array<{ id: string; name: string; kind: ModKind; notes: string[] }>;
  failed: Array<{ source: string; error: string }>;
}

export interface VerifyView {
  clean: boolean;
  missing: string[];
  orphans: string[];
}

export interface SaveSnapshotView {
  id: string;
  /** When the snapshot was taken. */
  createdAt: string;
  label: string;
  size: number;
  /** When the game itself last wrote a save inside it. */
  savedAt?: string;
  /** How many save files it holds. */
  fileCount: number;
}

export interface ApplyReport {
  added: number;
  removed: number;
  kept: number;
  problems: string[];
  /** Settings files saved onto the outgoing profile. */
  graphicsCaptured: number;
  /** Settings files restored for the incoming profile. */
  graphicsRestored: number;
}

/** A group of community links shown on the speedrun tab. */
export interface SpeedrunResourceGroup {
  title: string;
  blurb: string;
  items: Array<{ name: string; url: string; note?: string; discord?: boolean }>;
}

/** A speedrunning tool and whether it is installed. */
export interface SpeedrunToolView {
  id: string;
  name: string;
  summary: string;
  url: string;
  core: boolean;
  installed: boolean;
  path?: string;
}

/** A ScriptHookV copy found on the machine, offered for one-click setup. */
export interface HookCandidateView {
  path: string;
  gameId: GameId | null;
  source: 'downloads' | 'game-folder';
  modifiedAt: string;
  version?: string;
  /** A few representative filenames, so the user can sanity-check it. */
  contents: string[];
}

/** Whether ScriptHookV setup is needed, and what is available to do it with. */
export interface HookStatus {
  /** Installed games that need ScriptHookV and do not have it. */
  missingFor: GameId[];
  /**
   * Installed games that need ScriptHookV and already have it.
   *
   * Reported so the prompt can say what is already covered. Without it, a
   * user with Legacy set up and Enhanced not just sees "Enhanced needs
   * ScriptHookV" with no indication that the two take different builds and
   * that their Legacy copy is not transferable.
   */
  presentFor: GameId[];
  /** Copies already on this machine. */
  candidates: HookCandidateView[];
  /** The official download page. */
  url: string;
}

/** Hand-installed files found in the game folder, offered for import. */
export interface AdoptGroupView {
  id: string;
  name: string;
  files: string[];
  bytes: number;
  core: boolean;
  alreadyInLibrary?: string;
}

/** Per-profile settings state, for the profile panel. */
export interface GraphicsView {
  supported: boolean;
  captured: boolean;
  capturedAt?: string;
  files: Array<{ label: string; path: string; live: boolean; captured: boolean }>;
}

export interface ProgressEvent {
  done: number;
  total: number;
  label: string;
}

/**
 * Every operation the UI can perform. Implemented in the main process,
 * mirrored onto `window.swapmeet` by the preload script.
 */
export interface SwapmeetApi {
  getState(): Promise<AppState>;
  selectGame(gameId: GameId): Promise<AppState>;

  /** Re-run storefront and registry detection for every title. */
  detectGames(): Promise<AppState>;
  /** Open a folder picker and register whatever game it turns out to be. */
  browseForGame(gameId: GameId): Promise<AppState>;
  /** Forget a game's install path without touching any files. */
  forgetGame(gameId: GameId): Promise<AppState>;

  /**
   * Open a picker and import the result.
   *
   * Windows cannot show a dialog that accepts files *and* folders at once, so
   * the caller has to say which one it wants.
   */
  importMods(
    gameId: GameId,
    mode: 'files' | 'folder',
  ): Promise<{ state: AppState; report: ImportReport }>;
  /** Import specific paths, used by drag-and-drop. */
  importPaths(gameId: GameId, paths: string[]): Promise<{ state: AppState; report: ImportReport }>;
  /** Delete a mod from the library. Undeploys it first if it is live. */
  removeMod(modId: string): Promise<AppState>;
  /** Update editable mod fields (name, category, requires, core). */
  updateMod(modId: string, patch: Partial<Pick<Mod, 'name' | 'category' | 'requires' | 'core' | 'notes'>>): Promise<AppState>;

  /** Switch a mod on or off within the active profile. */
  toggleMod(profileId: string, modId: string, enabled: boolean): Promise<AppState>;
  /** Move a mod to a new index in the load order. */
  moveMod(profileId: string, modId: string, toIndex: number): Promise<AppState>;
  /** Push core mods to the top of the load order. */
  tidyOrder(profileId: string): Promise<AppState>;

  createProfile(gameId: GameId, name: string, copyFromId?: string): Promise<AppState>;
  renameProfile(profileId: string, name: string): Promise<AppState>;
  deleteProfile(profileId: string): Promise<AppState>;
  /** Select a profile in the UI. Does not deploy it. */
  setActiveProfile(gameId: GameId, profileId: string): Promise<AppState>;

  /** Preview what applying a profile would do. */
  planSwap(profileId: string): Promise<SwapPlan>;
  /** Apply a profile to the game folder. */
  applyProfile(profileId: string): Promise<{ state: AppState; report: ApplyReport }>;
  /** Remove every deployed file, returning the game folder to vanilla. */
  undeployAll(gameId: GameId): Promise<{ state: AppState; problems: string[] }>;
  /** Check the game folder against the manifest. */
  verify(gameId: GameId): Promise<VerifyView>;

  /** Mod files already sitting in the game folder that Swapmeet did not install. */
  scanAdoptable(gameId: GameId): Promise<AdoptGroupView[]>;
  /** Copy such files into the library so Swapmeet can manage them. */
  adopt(gameId: GameId, groupId: string): Promise<{ state: AppState; message: string }>;

  /** Speedrunning tools relevant to this game, and whether each is installed. */
  speedrunTools(gameId: GameId): Promise<SpeedrunToolView[]>;
  /** Point Swapmeet at a portable tool it could not find, and remember it. */
  locateSpeedrunTool(toolId: string, gameId: GameId): Promise<SpeedrunToolView[]>;
  /** Start an installed speedrunning tool. */
  launchSpeedrunTool(toolId: string, gameId: GameId): Promise<void>;
  /**
   * The community guides, splits and routing documents.
   *
   * Served over IPC rather than duplicated in the renderer, which cannot
   * import at runtime — one source of truth for the list.
   */
  speedrunResources(): Promise<SpeedrunResourceGroup[]>;

  /** Is ScriptHookV missing, and is there a copy already on this machine? */
  hookStatus(): Promise<HookStatus>;
  /**
   * Install a found ScriptHookV copy into the given games. Used by the
   * first-run prompt and by the watcher when a download appears.
   */
  installHook(
    sourcePath: string,
    gameIds: GameId[],
  ): Promise<{ state: AppState; installedFor: GameId[]; message: string }>;

  /** Settings tracked for a profile. */
  graphicsFor(profileId: string): Promise<GraphicsView>;
  /** Save the game's current settings onto a profile. */
  captureGraphics(profileId: string): Promise<{ state: AppState; count: number }>;
  /** Forget a profile's saved settings. */
  clearGraphics(profileId: string): Promise<AppState>;

  listSaves(gameId: GameId): Promise<SaveSnapshotView[]>;
  backupSaves(gameId: GameId, label: string): Promise<SaveSnapshotView[]>;
  restoreSave(gameId: GameId, snapshotId: string): Promise<SaveSnapshotView[]>;

  /** Apply the profile, then start the game. */
  launchGame(gameId: GameId): Promise<{ ok: boolean; error?: string }>;
  /** Reveal a folder in the OS file manager. */
  openPath(
    which: 'game' | 'library' | 'shelf' | 'config' | 'saves',
    gameId?: GameId,
  ): Promise<void>;

  updateSettings(patch: Partial<AppConfig['settings']>): Promise<AppState>;

  // --- mod browser ---------------------------------------------------------

  /** List mods from a provider. */
  browse(query: BrowseQuery): Promise<BrowseResult>;
  /** Fetch a mod's downloadable files (Nexus needs a second call). */
  catalogFiles(mod: CatalogMod, gameId: GameId): Promise<CatalogFile[]>;
  /**
   * Download a catalog file and import it into the library. Executables are
   * staged but never imported, and say so in the result.
   */
  installCatalogFile(
    mod: CatalogMod,
    file: CatalogFile,
    gameId: GameId,
  ): Promise<{ state: AppState; imported: boolean; message: string }>;
  /** Discard cached provider metadata and re-query. */
  refreshCatalog(): Promise<void>;
  /**
   * Install the Essentials entry that provides a detected dependency.
   * Returns a message when the tool has to be fetched by hand instead.
   */
  installDependency(
    essentialId: string,
    gameId: GameId,
  ): Promise<{ state: AppState; imported: boolean; message: string }>;
  /** Re-run dependency detection over the whole library for a game. */
  rescanDependencies(gameId: GameId): Promise<AppState>;

  /** Mod sites available for a game. */
  listSites(gameId: GameId): Promise<ModSite[]>;
  /** Open the embedded browser at a site. Downloads there are captured. */
  openSite(siteId: string, gameId: GameId): Promise<void>;
  /** Open a URL in the user's real browser. http/https only. */
  openExternal(url: string): Promise<void>;

  /** Store and validate a Nexus personal API key. */
  setNexusKey(apiKey: string): Promise<{ state: AppState; account: NexusAccount | null; error?: string }>;
  /** Forget the stored Nexus key. */
  clearNexusKey(): Promise<AppState>;

  /** Window chrome, since the app draws its own title bar. */
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
}

export type ApiMethod = keyof SwapmeetApi;
