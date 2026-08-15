/**
 * Adopting mods that are already in the game folder.
 *
 * Almost nobody arrives at a mod manager with a clean install. ScriptHookV in
 * particular is installed by unzipping it straight into the game directory,
 * so a first-time user opens Swapmeet, sees an empty library, and reasonably
 * concludes it cannot see the mods they already have.
 *
 * This scans the places mods actually land, ignores everything the base game
 * ships and everything Swapmeet deployed itself, and groups what is left into
 * recognisable tools. Adopting one copies the files into the library and
 * enables it — after which the normal deploy diff owns them, so they can be
 * disabled, reordered and undone like anything else.
 *
 * Copies rather than moves: if adoption goes wrong the game folder is still
 * exactly as it was.
 */

import path from 'node:path';

import { getGame } from '../shared/games';
import type { AppConfig, GameId } from '../shared/types';
import { readManifest } from './deploy';
import { exists, toPosix, walk } from './fsutil';

/** A recognisable tool, so an adopted group gets a sensible name. */
interface Signature {
  id: string;
  name: string;
  /** Files that identify it, relative to the game root. */
  match: RegExp;
  /** Everything it owns, so the whole tool is adopted together. */
  owns: RegExp;
  core: boolean;
}

const SIGNATURES: Signature[] = [
  {
    id: 'scripthookv',
    name: 'ScriptHookV',
    match: /^scripthookv\.dll$/i,
    owns: /^(scripthookv\.dll|dinput8\.dll|nativetrainer\.asi|xinput1_4\.dll|args\.txt|how_to_install.*\.txt|readme\.txt|www\.dev-c\.com\.url)$/i,
    core: true,
  },
  {
    id: 'scripthookvdotnet',
    name: 'ScriptHookV .NET',
    match: /^scripthookvdotnet\.asi$/i,
    owns: /^scripthookvdotnet.*\.(asi|dll|ini|xml)$/i,
    core: true,
  },
  {
    id: 'ultimate-asi-loader',
    name: 'ASI loader',
    match: /^(dinput8|dsound|winmm|version|vorbisfile|binkw32|xlive|wininet)\.dll$/i,
    owns: /^(dinput8|dsound|winmm|version|vorbisfile|binkw32|xlive|wininet)\.dll$/i,
    core: true,
  },
  {
    id: 'cleo',
    name: 'CLEO',
    match: /^cleo(_redux)?\.asi$/i,
    owns: /^(cleo(_redux)?\.asi|cleo\/.*)$/i,
    core: true,
  },
  {
    id: 'modloader',
    name: 'modloader',
    match: /^modloader\.asi$/i,
    owns: /^(modloader\.asi|modloader\/.*)$/i,
    core: true,
  },
];

/** A candidate set of files the user could import. */
export interface AdoptGroup {
  id: string;
  name: string;
  /** Game-relative paths. */
  files: string[];
  bytes: number;
  /** True when this is a load-bearing tool other mods need. */
  core: boolean;
  /** Set when a library mod with the same name already exists. */
  alreadyInLibrary?: string;
}

/**
 * Files that may belong to a mod, once we already know the group they join.
 * Never enough on its own to call something a mod.
 */
const MOD_FILE = /\.(asi|dll|cs|cm|lua|pak|ucas|utoc|oiv|ini|xml|txt|url)$/i;

/**
 * Proxy DLL names, which are ASI loaders wherever they appear.
 * `binkw32` is the 3D-era proxy; `bink2w64.dll` is the HD games' own video
 * codec and must not be confused with it.
 */
const PROXY_DLL = /^(dinput8|dsound|winmm|version|vorbisfile|binkw32|xlive|wininet)\.dll$/i;

/**
 * Directories that exist only because a mod created them. A file inside one
 * is a mod; the same file at the game root is not.
 */
const MOD_ONLY_DIR = /(^|\/)(scripts|cleo|modloader|~mods|ue4ss)(\/|$)/i;

/**
 * Is this file evidence of a mod, on its own?
 *
 * The bar is deliberately high. The HD-era games ship dozens of loose vendor
 * DLLs at their root — `steam_api64.dll`, `nvngx_dlss.dll`, `bink2w64.dll`,
 * `zlib1.dll` — and the Definitive Editions keep their entire engine in
 * `Gameface/Binaries/Win64`, which is also where DLL mods go. Treating any
 * loose `.dll` as a mod offered to "adopt" the game's own binaries, after
 * which disabling that mod would break the install.
 *
 * So a bare `.dll` never counts. Only an `.asi`, an OpenIV package, a
 * recognised proxy loader, or a file living inside a directory that only
 * exists for mods.
 */
function isModEvidence(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (base.endsWith('.asi') || base.endsWith('.oiv')) return true;
  if (PROXY_DLL.test(base)) return true;

  const dir = toPosix(path.dirname(rel)).toLowerCase();
  if (MOD_ONLY_DIR.test(dir)) {
    return /\.(dll|cs|cm|lua|pak|ucas|utoc|asi|xml|ini)$/i.test(base);
  }
  return false;
}

/**
 * Find mod files in the game folder that Swapmeet did not put there.
 *
 * Scanning is limited to the game root and the folders mods deploy into.
 * Walking a 100 GB install would be pointless, and the base game's own
 * archives live in directories that are excluded by `protectedPaths` anyway.
 */
export async function findAdoptable(
  config: AppConfig,
  gameId: GameId,
  gamePath: string,
): Promise<AdoptGroup[]> {
  const def = getGame(gameId);
  const manifest = await readManifest(config, gameId);
  const deployed = new Set((manifest?.files ?? []).map((f) => f.target.toLowerCase()));

  // The game root plus each deploy root, one level of depth each.
  const roots = new Set<string>(['']);
  for (const root of Object.values(def.deployRoots)) {
    if (root) roots.add(root);
  }

  const found = new Map<string, number>(); // relative path -> size
  for (const root of roots) {
    const dir = root ? path.join(gamePath, root) : gamePath;
    if (!(await exists(dir))) continue;

    // Depth-limited: the game root itself is shallow, deploy roots get a full
    // walk because that is where a tool's own subfolder lives.
    const files = await walk(dir);
    for (const file of files) {
      const rel = toPosix(root ? `${root}/${file.rel}` : file.rel);
      // Skip the base game's own protected files and anything we deployed.
      if (isProtectedish(def.protectedPaths, rel)) continue;
      if (deployed.has(rel.toLowerCase())) continue;
      if (!MOD_FILE.test(rel)) continue;
      // The game root is flat: ignore deep paths picked up from a walk of it.
      if (root === '' && rel.includes('/')) continue;
      found.set(rel, file.size);
    }
  }

  // Nothing that is evidence of a mod on its own means nothing to adopt.
  // Companion files (a readme, an .ini) stay in `found` so a recognised tool
  // can still claim them, but they can never form a group by themselves.
  const evidence = new Set([...found.keys()].filter((rel) => isModEvidence(rel)));
  if (evidence.size === 0) return [];

  const remaining = new Map(found);
  const groups: AdoptGroup[] = [];

  // Named tools first, so their loose files do not become an "other" pile.
  for (const sig of SIGNATURES) {
    const anchor = [...remaining.keys()].find((rel) => sig.match.test(path.basename(rel)));
    if (!anchor) continue;

    const owned = [...remaining.keys()].filter(
      (rel) => sig.owns.test(rel) || sig.owns.test(path.basename(rel)),
    );
    if (owned.length === 0) continue;

    let bytes = 0;
    for (const rel of owned) {
      bytes += remaining.get(rel) ?? 0;
      remaining.delete(rel);
    }

    groups.push({
      id: sig.id,
      name: sig.name,
      files: owned.sort(),
      bytes,
      core: sig.core,
    });
  }

  // Anything left that is unmistakably a mod becomes its own entry. Only
  // files that passed the evidence bar qualify, so the game's own vendor
  // DLLs are never offered.
  for (const [rel, size] of remaining) {
    if (!evidence.has(rel)) continue;
    groups.push({
      id: `loose-${path.basename(rel).toLowerCase()}`,
      name: path.basename(rel),
      files: [rel],
      bytes: size,
      core: false,
    });
  }

  // Flag what the library already has, so adoption does not duplicate it.
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const group of groups) {
    const hit = config.mods.find(
      (m) => m.gameId === gameId && normalise(m.name).includes(normalise(group.name)),
    );
    if (hit) group.alreadyInLibrary = hit.id;
  }

  return groups;
}

/** Prefix match against the game's protected paths. */
function isProtectedish(protectedPaths: string[], rel: string): boolean {
  const lower = rel.toLowerCase();
  return protectedPaths.some((p) => {
    const prefix = toPosix(p).toLowerCase().replace(/\*+$/, '');
    return lower === prefix || lower.startsWith(prefix);
  });
}
