/**
 * Core data model shared by the main process, the preload bridge and the
 * renderer. Everything here must be structured-clone friendly: plain data
 * only, no class instances, no functions.
 */

/** Every title Swapmeet knows how to manage. */
export type GameId =
  // 3D era, original releases
  | 'gta3'
  | 'gtavc'
  | 'gtasa'
  // 3D era, Definitive Edition remasters (Unreal Engine 4)
  | 'gta3de'
  | 'gtavcde'
  | 'gtasade'
  // HD era
  | 'gta4'
  | 'gta5'
  | 'gta5e';

/**
 * How a mod wants to be installed. The kind decides which folder inside the
 * game directory its files are laid down into, which is the one part of
 * modding that differs wildly between the 3D-era games and the HD-era ones.
 */
export type ModKind =
  | 'asi' // .asi plugin loaded by an ASI loader
  | 'script' // ScriptHookVDotNet / .NET script (.dll, .cs)
  | 'cleo' // CLEO script for III / VC / SA
  | 'modloader' // a modloader-managed folder (III / VC / SA)
  | 'oiv' // OpenIV package, applied to the mods/ folder
  | 'replace' // loose file replacements inside mods/
  | 'pak' // Unreal Engine 4 pak/ucas/utoc, for the Definitive Editions
  | 'lua' // UE4SS Lua mod, for the Definitive Editions
  | 'graphics' // ENB / ReShade / timecycle, sits at the game root
  | 'raw'; // unknown layout: deployed verbatim relative to the game root

export const MOD_KINDS: ModKind[] = [
  'asi',
  'script',
  'cleo',
  'modloader',
  'oiv',
  'replace',
  'pak',
  'lua',
  'graphics',
  'raw',
];

/** Where a settings file lives, since they are not all in one place. */
export type GraphicsBase = 'documents' | 'game' | 'localappdata';

/** One settings file that can travel with a profile. */
export interface GraphicsFile {
  /** Root the path is relative to. */
  base: GraphicsBase;
  /** Path relative to that root. */
  rel: string;
  /** Shown in the UI. */
  label: string;
}

/** Static, hand-maintained knowledge about one game. */
export interface GameDef {
  id: GameId;
  /** Full title as Rockstar writes it. */
  name: string;
  /** Compact label for the UI chrome. */
  shortName: string;
  /**
   * Era, which is what actually drives modding conventions.
   * `3d` = the original III/VC/SA engine, `hd` = RAGE (IV/V),
   * `de` = the Unreal Engine 4 Definitive Edition remasters.
   */
  era: '3d' | 'hd' | 'de';
  /**
   * The game's own executables, most specific first. Used for detection and
   * for deciding whether the game is currently running.
   */
  executables: string[];
  /**
   * How to actually start the game, in order of preference.
   *
   * This is not the same list as `executables`. The HD-era titles refuse to
   * run when their main binary is launched directly -- GTA V pops
   * `ERR_NO_LAUNCHER` and quits -- so the Rockstar launcher shim has to go
   * first. Detection wants the opposite: the shim tells you nothing about
   * whether the game is running.
   */
  launchWith?: string[];
  /** A folder is only accepted as this game if it contains one of these. */
  signatureFiles: string[];
  /** Steam app ids used for library lookups. */
  steamAppIds: number[];
  /** Folder names under steamapps/common. */
  steamFolderNames: string[];
  /** Registry paths probed during auto-detection (Windows only). */
  registryKeys: string[];
  /** Where each supported mod kind lands, relative to the game root. */
  deployRoots: Partial<Record<ModKind, string>>;
  /** Kinds this game can actually take. */
  supportedKinds: ModKind[];
  /**
   * Paths Swapmeet will never write into or clean up, relative to the game
   * root. Protects the base install from a bad mod archive.
   */
  protectedPaths: string[];
  /** Save-game locations relative to the user's Documents folder. */
  savePaths: string[];
  /**
   * Files holding the game's graphics and launch settings.
   *
   * These do not live with the mods — they sit in Documents, in the game
   * folder, or in LocalAppData — so they survive a profile swap untouched.
   * That is why a modded setup that needs different settings from a vanilla
   * one has to be reconfigured by hand on every switch. Tracking them per
   * profile is what stops that.
   */
  graphicsFiles?: GraphicsFile[];
  /** True when the title has an online mode that bans for modding. */
  hasOnline: boolean;
  /** Shown in the UI when the game is selected. */
  notes: string;
}

/** A game found on disk. */
export interface GameInstall {
  gameId: GameId;
  /** Absolute path to the game root. */
  path: string;
  /** How we found it, for display and debugging. */
  source: 'steam' | 'epic' | 'rockstar' | 'registry' | 'scan' | 'manual';
  /** Executable version string when we can read one. */
  version?: string;
}

/**
 * Something a mod needs in order to work, worked out by inspecting its files
 * rather than by trusting a description.
 */
export interface ModDependency {
  /** Stable capability id, e.g. `scripthookv`, `cleo`, `ue4ss`. */
  capability: string;
  /** Human label for the UI. */
  label: string;
  /** The evidence that produced this, shown so the user can judge it. */
  reason: string;
  /** Essentials catalog id that provides it, when Swapmeet can install it. */
  essentialId?: string;
  /** True when the mod works without it, just with less. */
  optional?: boolean;
  /** Filled in at read time: the library mod that already satisfies this. */
  satisfiedBy?: string;
}

/** One mod in the library. Files live outside the game folder until deployed. */
export interface Mod {
  id: string;
  gameId: GameId;
  name: string;
  kind: ModKind;
  version: string;
  /** Absolute path to this mod's folder inside the library. */
  path: string;
  /** Game-relative paths this mod owns once deployed. */
  files: string[];
  /** Total size on disk, bytes. */
  size: number;
  /** ISO timestamp of import. */
  addedAt: string;
  /** Free-text category used for the UI filter chips. */
  category: string;
  /** Mods that must be enabled for this one to work. */
  requires: string[];
  /**
   * Prerequisites detected by inspecting the mod's files (PE import tables,
   * layout, readme text). Independent of `requires`, which holds library mod
   * ids the planner enforces; these are capabilities, which may or may not be
   * installed yet.
   */
  dependencies?: ModDependency[];
  /** True for ScriptHookV and friends: cannot be disabled while others need it. */
  core: boolean;
  source?: string;
  notes?: string;
}

/** An ordered, named set of enabled mods. */
export interface Profile {
  id: string;
  gameId: GameId;
  name: string;
  /** Mod ids in load order. Later entries win file conflicts. */
  order: string[];
  /** Subset of `order` that is switched on. */
  enabled: string[];
  createdAt: string;
  lastLaunchedAt?: string;
  /**
   * Files switched off inside a mod, keyed by mod id, as mod-relative paths.
   *
   * This is the one thing people leave Vortex for Mod Organizer 2 to get:
   * losing a single file to another mod without unpacking and repacking the
   * archive by hand.
   *
   * It lives on the profile, not the mod, and that is not an implementation
   * detail. Two profiles routinely share a mod while wanting different parts
   * of it — a texture pack whose road textures you want in one setup and not
   * another — and hanging exclusions off the mod would make those two profiles
   * silently overwrite each other every time you switched.
   */
  excludedFiles?: Record<string, string[]>;

  /**
   * A locked profile deploys nothing and verifies the game folder is clean.
   * This is the GTA Online safety valve.
   */
  vanillaLock: boolean;
}

/** One file that a deployment wrote, recorded so it can be undone exactly. */
export interface DeployedFile {
  /** Path relative to the game root. */
  target: string;
  /** Mod that won this path. */
  modId: string;
  /** How the file was placed. */
  method: 'hardlink' | 'copy';
  /**
   * Set when the deployment displaced a pre-existing game file. Absolute
   * path inside the shelf where the original was parked.
   */
  backup?: string;
}

/** The record of what is currently laid down in a game folder. */
export interface DeployManifest {
  version: 1;
  gameId: GameId;
  profileId: string;
  gamePath: string;
  deployedAt: string;
  files: DeployedFile[];
}

/** Two or more mods claiming the same game-relative path. */
export interface Conflict {
  /** The contested path, relative to the game root. */
  target: string;
  /** Mod ids claiming it, in load order. */
  modIds: string[];
  /** The mod that wins under the current order (last one). */
  winnerId: string;
}

/** A single line in the pre-swap preview. */
export interface DiffEntry {
  kind: 'in' | 'out' | 'keep';
  modId: string;
  name: string;
  /** Human-readable destination or origin. */
  path: string;
  fileCount: number;
}

/** Everything the user sees before committing to a profile swap. */
export interface SwapPlan {
  gameId: GameId;
  fromProfileId: string | null;
  toProfileId: string;
  entries: DiffEntry[];
  filesIn: number;
  filesOut: number;
  filesKept: number;
  bytesToWrite: number;
  conflicts: Conflict[];
  /** Blocking problems: missing dependencies, game running, no disk space. */
  blockers: string[];
  /** Non-blocking advisories. */
  warnings: string[];
}

/** Persisted application state. */
/** Executable build last seen per game. See shared/buildwatch.ts. */
export type SeenBuilds = Partial<Record<GameId, string>>;

export interface AppConfig {
  version: 1;
  /** Where mod files are kept. Defaults to userData/library. */
  libraryPath: string;
  /** Where displaced vanilla files and inactive profiles are parked. */
  shelfPath: string;
  installs: GameInstall[];
  mods: Mod[];
  profiles: Profile[];
  /** Active profile per game. */
  activeProfile: Partial<Record<GameId, string>>;

  /**
   * The game build last seen per game, so a Rockstar patch can be noticed.
   *
   * Every GTA V patch moves the memory addresses Script Hook V hooks, so every
   * ASI plugin and .NET script stops loading until Script Hook V catches up.
   * The game says nothing useful about this, and the usual next move is to
   * start uninstalling mods at random. Recording the build is what turns that
   * into one sentence on the next launch.
   */
  seenBuilds?: SeenBuilds;
  /** Last game the user had selected. */
  lastGameId?: GameId;
  /**
   * Nexus Mods personal API key, encrypted with the OS keychain where one is
   * available. Never store or log the decrypted value.
   */
  nexusApiKey?: string;
  settings: {
    /** Snapshot saves before every swap. */
    backupSavesOnSwap: boolean;
    /** How many save snapshots to keep per game. */
    saveBackupLimit: number;
    /** Prefer hardlinks; fall back to copying across volumes. */
    useHardlinks: boolean;
    /** Refuse to deploy while the game itself is running. */
    blockWhileGameRunning: boolean;
    /**
     * Carry each profile's graphics and launch settings with it, capturing
     * the outgoing profile's settings and restoring the incoming one's on
     * every swap. On by default: without it, a modded and a vanilla profile
     * share one settings file and overwrite each other.
     */
    graphicsPerProfile: boolean;
    /** Interface theme. */
    theme: 'dark' | 'light';
    /**
     * What to do when a newer Swapmeet is published.
     *
     * `notify` is the default rather than `auto`: this app writes to game
     * folders, and replacing itself without asking — potentially mid-session,
     * with a profile half-applied — is not a decision to make on the user's
     * behalf. `auto` is there for people who would rather not think about it.
     */
    autoUpdate: 'off' | 'notify' | 'auto';
    /**
     * Show the speedrunning tools and community resources.
     *
     * Off by default: it is a whole extra surface that most people modding a
     * game for fun have no use for, and burying the mod manager under a timer
     * and a routing spreadsheet would be the wrong default.
     */
    speedrunMode: boolean;
    /** Set once the first-run speedrun prompt has been answered either way. */
    speedrunAsked?: boolean;
    /**
     * Where the user told us a speedrun tool lives, keyed by tool id.
     *
     * Needed because LiveSplit — the one tool every runner has — ships as a
     * portable zip that people extract wherever they like, so probing install
     * directories finds it for almost nobody.
     */
    speedrunToolPaths?: Record<string, string>;
    /**
     * Warn before applying a modded profile to a title that has an online
     * mode. Off by default: GTA V drops you at a story/online chooser on every
     * launch, so this fires on essentially every swap and becomes noise.
     * Anyone who does play online can switch it on.
     */
    warnAboutOnline: boolean;
  };
}
