/**
 * Mod sites, browsed in-app.
 *
 * The big community sites -- GTA5-Mods, GTAinside, LibertyCity -- have no
 * public API, and scraping them would be brittle, rude and against their
 * terms. So Swapmeet does not pretend to index them. It opens a real browser
 * window instead.
 *
 * You log in with your own account, on the real site, seeing the real page.
 * Swapmeet's only involvement is at the very end: it listens for a download
 * starting and catches the file into the mod library instead of dumping it in
 * your Downloads folder. The site keeps its traffic, its ads and its
 * attribution; Swapmeet never sees your password and never automates a click.
 *
 * The GTAMods wiki is listed here too, but only as documentation -- it hosts
 * no mod files at all.
 */

import type { GameId } from './types';

export interface ModSite {
  id: string;
  name: string;
  /** One-line description shown on the card. */
  blurb: string;
  /** Games this site actually covers. */
  games: GameId[];
  /** Landing page per game, falling back to `home`. */
  home: string;
  urls?: Partial<Record<GameId, string>>;
  /**
   * True when the site is a documentation resource rather than a place to
   * download mods.
   */
  docsOnly?: boolean;
  /** Whether an account is usually needed to download. */
  loginNote?: string;
}

const ALL_GAMES: GameId[] = [
  'gta5e',
  'gta5',
  'gta4',
  'gtasade',
  'gtavcde',
  'gta3de',
  'gtasa',
  'gtavc',
  'gta3',
];

export const MOD_SITES: ModSite[] = [
  {
    id: 'gta5mods',
    name: 'GTA5-Mods',
    blurb:
      'The largest GTA V mod site: vehicles, scripts, maps, liveries and graphics packs.',
    games: ['gta5', 'gta5e'],
    home: 'https://www.gta5-mods.com/',
    loginNote: 'Downloads work without an account, but logging in lets you keep favourites.',
  },
  {
    id: 'gtainside',
    name: 'GTAinside',
    blurb:
      'Long-running archive covering every GTA title, strongest on the 3D-era games.',
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
    home: 'https://www.gtainside.com/',
    urls: {
      gta5: 'https://www.gtainside.com/en/gta5/',
      gta5e: 'https://www.gtainside.com/en/gta5/',
      gta4: 'https://www.gtainside.com/en/gta4/',
      gtasa: 'https://www.gtainside.com/en/sanandreas/',
      gtavc: 'https://www.gtainside.com/en/vicecity/',
      gta3: 'https://www.gtainside.com/en/gta3/',
    },
    loginNote: 'A free account removes the download wait on some files.',
  },
  {
    id: 'libertycity',
    name: 'LibertyCity',
    blurb: 'Very large mixed archive spanning the whole series, including the remasters.',
    games: ALL_GAMES,
    home: 'https://libertycity.net/',
    urls: {
      gta5: 'https://libertycity.net/files/gta-5/',
      gta5e: 'https://libertycity.net/files/gta-5/',
      gta4: 'https://libertycity.net/files/gta-4/',
      gtasa: 'https://libertycity.net/files/gta-san-andreas/',
      gtavc: 'https://libertycity.net/files/gta-vice-city/',
      gta3: 'https://libertycity.net/files/gta-3/',
    },
  },
  {
    id: 'nexus',
    name: 'Nexus Mods',
    blurb:
      'Curated and well-moderated, with proper versioning. Also usable through the API key in Settings.',
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
    home: 'https://www.nexusmods.com/',
    urls: {
      gta5: 'https://www.nexusmods.com/grandtheftautov',
      gta5e: 'https://www.nexusmods.com/grandtheftautov',
      gta4: 'https://www.nexusmods.com/grandtheftauto4',
      gtasa: 'https://www.nexusmods.com/grandtheftautosanandreas',
      gtavc: 'https://www.nexusmods.com/grandtheftautovicecity',
      gta3: 'https://www.nexusmods.com/grandtheftauto3',
    },
    loginNote: 'An account is required to download.',
  },
  {
    id: 'moddb',
    name: 'ModDB',
    blurb: 'Home to the bigger total-conversion and overhaul projects.',
    games: ALL_GAMES,
    home: 'https://www.moddb.com/games/grand-theft-auto',
  },
  {
    id: 'gtamods',
    name: 'GTAMods Wiki',
    blurb:
      'Documentation, not downloads: file formats, tools and modding guides for every era.',
    games: ALL_GAMES,
    home: 'https://gtamods.com/wiki/Main_Page',
    docsOnly: true,
  },
];

export function sitesFor(gameId: GameId): ModSite[] {
  return MOD_SITES.filter((s) => s.games.includes(gameId));
}

export function siteUrl(site: ModSite, gameId: GameId): string {
  return site.urls?.[gameId] ?? site.home;
}

// --- GTAMods wiki reference layer ------------------------------------------

/**
 * Deep links into the GTAMods wiki, used to answer "what even is this file?"
 * from the conflict panel and the mod list.
 *
 * Every title here was checked to resolve; the wiki's API is closed, so these
 * are plain page links rather than anything fetched.
 */
const WIKI_BASE = 'https://gtamods.com/wiki/';

const KIND_ARTICLES: Record<string, string> = {
  asi: 'ASI',
  cleo: 'CLEO',
  modloader: 'Mod_Loader',
  oiv: 'OpenIV',
  replace: 'RPF_archive',
  script: 'Scripts',
  graphics: 'Timecyc.dat',
};

/** Filenames modders argue about most, mapped to their documentation. */
const FILE_ARTICLES: Array<[RegExp, string]> = [
  [/handling\.(meta|cfg)$/i, 'Handling.meta'],
  [/\.img$/i, 'IMG_archive'],
  [/\.rpf$/i, 'RPF_archive'],
  [/timecyc/i, 'Timecyc.dat'],
  [/\.ide$/i, 'Item_Definition'],
  [/\.ipl$/i, 'Item_Placement'],
  [/\.dat$/i, 'Data_files'],
  [/\.asi$/i, 'ASI'],
  [/\.(cs|cm)$/i, 'CLEO'],
];

/** A documentation link for a mod kind, when one exists. */
export function wikiForKind(kind: string): string | null {
  const article = KIND_ARTICLES[kind];
  return article ? `${WIKI_BASE}${article}` : null;
}

/** A documentation link for a specific game file, when one exists. */
export function wikiForFile(filePath: string): string | null {
  for (const [pattern, article] of FILE_ARTICLES) {
    if (pattern.test(filePath)) return `${WIKI_BASE}${article}`;
  }
  return null;
}

/** Free-text wiki search, for the "look this up" affordance. */
export function wikiSearch(query: string): string {
  return `https://gtamods.com/index.php?search=${encodeURIComponent(query)}`;
}
