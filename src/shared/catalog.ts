/**
 * The mod browser's data model.
 *
 * GTArage does not host mods and does not scrape sites that do not want to be
 * scraped. It talks to two sources, both of which are meant to be talked to:
 *
 *  - **Essentials** - a curated catalog of the load-bearing tools the whole
 *    modding scene depends on (script hooks, ASI loaders, CLEO, UE4SS),
 *    resolved live through the public GitHub Releases API. Works with no
 *    account and no configuration.
 *
 * A few essential tools are not distributed through either (ScriptHookV and
 * OpenIV are hosted on their authors' own sites). Those appear in the catalog
 * as link-outs: GTArage shows what they are and opens the official page, and
 * never invents a download URL for them.
 */

import type { GameId } from './types';

export type ProviderId = 'essentials';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  essentials: 'Essentials',
};

/** One downloadable file belonging to a catalog mod. */
export interface CatalogFile {
  id: string;
  name: string;
  /** Bytes, or 0 when the provider does not say up front. */
  size: number;
  /** Direct download URL when the provider gives one without a handshake. */
  url?: string;
  /**
   * True for installers and loose executables. GTArage will download them
   * only on an explicit second confirmation and never imports or runs them.
   */
  executable: boolean;
  description?: string;
  /** The file most users want, highlighted in the UI. */
  primary?: boolean;
}

/** A mod as presented by the browser, before anything is downloaded. */
export interface CatalogMod {
  providerId: ProviderId;
  /** Stable within its provider. */
  id: string;
  name: string;
  summary: string;
  author: string;
  version: string;
  /** The mod's own web page. */
  url: string;
  category: string;
  updatedAt?: string;
  downloads?: number;
  endorsements?: number;
  /**
   * Set when the mod cannot be fetched automatically - either the provider
   * requires a handshake GTArage cannot perform, or the author distributes it
   * from their own site.
   */
  manualOnly?: boolean;
  manualReason?: string;
  /** Library mod id, when this is already installed. */
  installedModId?: string;
  /** Library mod version, when installed, so the UI can flag updates. */
  installedVersion?: string;
  files: CatalogFile[];
}

export type BrowseSort = 'trending' | 'latest' | 'updated';

export interface BrowseQuery {
  gameId: GameId;
  providerId: ProviderId;
  sort: BrowseSort;
  search: string;
}

export interface BrowseResult {
  mods: CatalogMod[];
  /** Set when the provider is unavailable, so the UI can explain why. */
  error?: string;
  /** True when the provider needs setup before it can return anything. */
  needsSetup?: boolean;
}

// --- the curated essentials catalog ----------------------------------------

export interface EssentialDef {
  id: string;
  name: string;
  summary: string;
  author: string;
  category: string;
  games: GameId[];
  /** `owner/repo` on GitHub, when the tool is released there. */
  repo?: string;
  /** The project's own page. Used for link-outs and as the mod's URL. */
  homepage: string;
  /** Why this one cannot be downloaded automatically. */
  manualReason?: string;
  /**
   * Per-game release tag, for repos that publish one release per game.
   *
   * Widescreen Fixes Pack covers a hundred-odd games in a single repo, so its
   * "latest release" is whichever game was patched most recently -- at time
   * of writing, a Splinter Cell fix. Without a tag here, San Andreas would be
   * offered a mod for a different game entirely.
   */
  releaseTags?: Partial<Record<GameId, string>>;
  /**
   * Per-game asset selector (case-insensitive regex source).
   *
   * Needed wherever one release ships several builds. Architecture is the
   * common case and it is not cosmetic: the 3D-era games and GTA IV are
   * 32-bit, GTA V and the remasters are 64-bit, and the wrong ASI loader
   * simply never loads.
   */
  assetPatterns?: Partial<Record<GameId, string>>;
}

/**
 * The tools nearly every setup needs. Every repo here was checked against the
 * GitHub API; the two without a `repo` are distributed by their authors
 * elsewhere and are deliberately link-only.
 */
export const ESSENTIALS: EssentialDef[] = [
  {
    id: 'ultimate-asi-loader',
    name: 'Ultimate ASI Loader',
    summary:
      'The ASI loader for the classic games, which ship without one. Drops in as a proxy DLL and loads .asi plugins at startup.',
    author: 'ThirteenAG',
    category: 'core',
    /*
     * Deliberately not offered for GTA V or Enhanced.
     *
     * The ScriptHookV distribution already contains an ASI loader (its own
     * `dinput8.dll`, alongside `ScriptHookV.dll` and the Native Trainer), so
     * listing UAL there is not just redundant — both mods claim `dinput8.dll`
     * and produce a file conflict the user then has to resolve for no reason.
     *
     * The 3D-era games and GTA IV genuinely have no bundled loader, so it
     * stays for those. The Definitive Editions are Unreal Engine 4 and use
     * UE4SS instead, so they are not listed here either.
     */
    games: ['gta3', 'gtavc', 'gtasa', 'gta4'],
    repo: 'ThirteenAG/Ultimate-ASI-Loader',
    homepage: 'https://github.com/ThirteenAG/Ultimate-ASI-Loader',
    // The release ships `Ultimate-ASI-Loader.zip` (32-bit) and
    // `Ultimate-ASI-Loader_x64.zip`. Every game left on this list is a 32-bit
    // process, and the x64 build would simply never load.
    assetPatterns: {
      gta3: '^ultimate-asi-loader\\.zip$',
      gtavc: '^ultimate-asi-loader\\.zip$',
      gtasa: '^ultimate-asi-loader\\.zip$',
      gta4: '^ultimate-asi-loader\\.zip$',
    },
  },
  {
    id: 'scripthookvdotnet',
    name: 'ScriptHookV .NET',
    summary:
      'Runs .NET script mods in GTA V Legacy. Required by most modern script mods. Needs ScriptHookV itself alongside it.',
    author: 'crosire and contributors',
    category: 'core',
    games: ['gta5', 'gta5e'],
    repo: 'scripthookvdotnet/scripthookvdotnet',
    homepage: 'https://github.com/scripthookvdotnet/scripthookvdotnet',
  },

  /*
   * --- GTA V Enhanced ------------------------------------------------------
   *
   * Enhanced is not a patch on Legacy: different executable, 64-bit rebuild,
   * and BattlEye. Legacy's tooling does not transfer, so it gets its own
   * entries rather than sharing Legacy's.
   *
   * ScriptHookV is a single download that covers both Legacy and Enhanced,
   * so it is one catalogue entry listed for both games. An earlier version of
   * this file split it in two on the assumption that Enhanced needed its own
   * build; that was wrong and is not something to reintroduce.
   *
   * ScriptHookVDotNet is listed twice for a different and verifiable reason:
   * its newest *stable* release is v3.6.0 from 2022, while the official
   * nightly mirror is still building (checked August 2026). Both are offered
   * for both games, with the nightly described as the one to try when the
   * stable will not load — a statement about release dates, not a claim about
   * compatibility we have not tested.
   *
   * The limit adjusters matter more than they read: the RPF cap is what turns
   * "I added a few car mods" into a crash on load.
   */
  {
    id: 'scripthookvdotnet-nightly',
    name: 'ScriptHookV .NET (nightly)',
    summary:
      'The rolling build of ScriptHookV .NET. The stable release is from 2022, so the nightly is where support for newer game builds lands first — worth trying if the stable one will not load.',
    author: 'crosire and contributors',
    category: 'core',
    games: ['gta5', 'gta5e'],
    repo: 'scripthookvdotnet/scripthookvdotnet-nightly',
    homepage: 'https://github.com/scripthookvdotnet/scripthookvdotnet-nightly',
  },
  {
    id: 'rageopenv',
    name: 'RageOpenV',
    summary:
      'Open-source replacement for OpenIV.asi / OpenRPF.asi, handling the updated RPF archive format Enhanced uses. This is what keeps modded files in a mods/ folder instead of touching the vanilla archives.',
    author: 'Chiheb-Bacha',
    category: 'core',
    games: ['gta5', 'gta5e'],
    repo: 'Chiheb-Bacha/RageOpenV',
    homepage: 'https://github.com/Chiheb-Bacha/RageOpenV',
  },
  {
    id: 'packfile-limit-adjuster',
    name: 'Packfile Limit Adjuster',
    summary:
      'Raises the cap on how many RPF archives the game will load. Without it, adding a handful of vehicle or texture mods hits the limit and the game crashes on load.',
    author: 'Chiheb-Bacha',
    category: 'fixes',
    games: ['gta5', 'gta5e'],
    repo: 'Chiheb-Bacha/PackfileLimitAdjusterEnhanced',
    homepage: 'https://github.com/Chiheb-Bacha/PackfileLimitAdjusterEnhanced',
  },
  {
    id: 'modkit-limit-adjuster',
    name: 'Modkit Limit Adjuster',
    summary:
      'Raises the vehicle modkit limit. Needed once you run more than a few add-on or replacement vehicles.',
    author: 'Chiheb-Bacha',
    category: 'fixes',
    games: ['gta5', 'gta5e'],
    repo: 'Chiheb-Bacha/ModkitLimitAdjusterEnhanced',
    homepage: 'https://github.com/Chiheb-Bacha/ModkitLimitAdjusterEnhanced',
  },
  {
    id: 'straight-to-story',
    name: 'Straight to Story Mode',
    summary:
      'Skips the legal and splash screens, and the Enhanced landing page, dropping you straight into story mode. A large quality-of-life win when testing mods.',
    author: 'Chiheb-Bacha',
    category: 'tools',
    games: ['gta5', 'gta5e'],
    repo: 'Chiheb-Bacha/StraightToStoryMode',
    homepage: 'https://github.com/Chiheb-Bacha/StraightToStoryMode',
  },
  {
    id: 'scripthookv',
    name: 'ScriptHookV',
    summary:
      'The native script hook for GTA V — nearly every script mod needs it. The download also includes an ASI loader and the Native Trainer, so no separate loader is required. Note it disables itself in GTA Online.',
    author: 'Alexander Blade',
    category: 'core',
    // One build covers both Legacy and Enhanced.
    games: ['gta5', 'gta5e'],
    homepage: 'http://www.dev-c.com/gtav/scripthookv/',
    manualReason:
      'ScriptHookV is released only from the author’s own site, which has no download API. GTArage will open the page so you can fetch it, then you can drag the archive straight in.',
  },
  {
    id: 'openiv',
    name: 'OpenIV',
    summary:
      'The archive editor for RAGE-era games. Creates the mods/ folder that keeps modded files away from the vanilla archives.',
    author: 'OpenIV Team',
    category: 'tools',
    games: ['gta4', 'gta5', 'gta5e'],
    homepage: 'https://openiv.com/',
    manualReason:
      'OpenIV is distributed from openiv.com with its own installer. GTArage will open the page rather than guess at a download link.',
  },
  {
    id: 'cleo-redux',
    name: 'CLEO Redux',
    summary:
      'A modern rewrite of CLEO with JavaScript and TypeScript support, covering the 3D era through to GTA V.',
    author: 'CLEO Library',
    category: 'core',
    games: ['gta3', 'gtavc', 'gtasa', 'gta4', 'gta5'],
    repo: 'cleolibrary/CLEO-Redux',
    homepage: 'https://github.com/cleolibrary/CLEO-Redux',
    // Ships x86 and x64 archives plus a setup .exe; pick the archive matching
    // the game's architecture rather than letting the installer win.
    assetPatterns: {
      gta3: 'x86\\.zip$',
      gtavc: 'x86\\.zip$',
      gtasa: 'x86\\.zip$',
      gta4: 'x86\\.zip$',
      gta5: 'x64\\.zip$',
    },
  },
  {
    id: 'modloader',
    name: 'modloader',
    summary:
      'Loads 3D-era mods from their own folders instead of overwriting game files. The single biggest quality-of-life tool for III, Vice City and San Andreas.',
    author: 'thelink2012',
    category: 'core',
    games: ['gta3', 'gtavc', 'gtasa'],
    repo: 'thelink2012/modloader',
    homepage: 'https://github.com/thelink2012/modloader',
  },
  {
    id: 'silentpatch',
    name: 'SilentPatch',
    summary:
      'Fixes a long list of bugs the official patches never addressed. Recommended on every 3D-era install.',
    author: 'Silent (CookiePLMonster)',
    category: 'fixes',
    games: ['gta3', 'gtavc', 'gtasa'],
    repo: 'CookiePLMonster/SilentPatch',
    homepage: 'https://github.com/CookiePLMonster/SilentPatch',
    // One release carries the builds for all three games side by side
    // (SilentPatchIII / SilentPatchVC / SilentPatchSA), so the game decides
    // which asset rather than the release tag.
    assetPatterns: {
      gta3: 'silentpatchiii',
      gtavc: 'silentpatchvc',
      gtasa: 'silentpatchsa',
    },
  },
  {
    id: 'widescreen-fixes',
    name: 'Widescreen Fixes Pack',
    summary:
      'Proper widescreen and high-resolution support, plus assorted rendering fixes, for the older titles.',
    author: 'ThirteenAG',
    category: 'fixes',
    // GTA IV is deliberately absent: the repo has no release tag for it.
    games: ['gta3', 'gtavc', 'gtasa'],
    repo: 'ThirteenAG/WidescreenFixesPack',
    homepage: 'https://github.com/ThirteenAG/WidescreenFixesPack',
    // This repo covers a hundred-odd unrelated games, one release per game.
    // Its "latest release" is whichever game was patched most recently, so
    // without an explicit tag San Andreas gets offered a Splinter Cell fix.
    releaseTags: { gta3: 'gta3', gtavc: 'gtavc', gtasa: 'gtasa' },
    // Each tag also ships a separate frontend fix; the main one is wanted.
    assetPatterns: {
      gta3: 'widescreenfix\\.zip$',
      gtavc: 'widescreenfix\\.zip$',
      gtasa: 'widescreenfix\\.zip$',
    },
  },
  {
    id: 'ue4ss',
    name: 'UE4SS',
    summary:
      'Unreal Engine scripting system: Lua mods, a live property editor and a mod loader for the Definitive Edition remasters.',
    author: 'UE4SS-RE',
    category: 'core',
    games: ['gta3de', 'gtavcde', 'gtasade'],
    repo: 'UE4SS-RE/RE-UE4SS',
    homepage: 'https://github.com/UE4SS-RE/RE-UE4SS',
  },
];

/** Essentials that apply to a given game. */
export function essentialsFor(gameId: GameId): EssentialDef[] {
  return ESSENTIALS.filter((e) => e.games.includes(gameId));
}

