/**
 * Adopting mods that are already in the game folder.
 *
 * Almost nobody arrives at a mod manager with a clean install. ScriptHookV in
 * particular is installed by unzipping it straight into the game directory,
 * so a first-time user opens GTArage, sees an empty library, and reasonably
 * concludes it cannot see the mods they already have.
 *
 * This scans the places mods actually land, ignores everything the base game
 * ships and everything GTArage deployed itself, and groups what is left into
 * recognisable tools. Adopting one copies the files into the library and
 * enables it — after which the normal deploy diff owns them, so they can be
 * disabled, reordered and undone like anything else.
 *
 * Copies rather than moves: if adoption goes wrong the game folder is still
 * exactly as it was.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getGame } from '../shared/games';
import type { AppConfig, GameId } from '../shared/types';
import { readManifest } from './deploy';
import { exists, isDirectory, toPosix, walk } from './fsutil';

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
 * Engine and vendor libraries the games ship with. Never a mod, anywhere.
 *
 * The rules below are already meant to exclude these by requiring positive
 * evidence, but this list is a hard floor underneath them: offering someone
 * their own `steam_api64.dll` as a mod, and then letting them "disable" it,
 * breaks the game. Every name here was observed in a real GTA V, GTA V
 * Enhanced or Definitive Edition install.
 */
/**
 * Does `folder` look like the data folder belonging to `asiBase`?
 *
 * An exact name match is what this used to require, and it is wrong for most
 * of the mods that actually have a data folder:
 *
 *   ChaosModV.asi     ->  chaosmod/      (the plugin carries a version suffix)
 *   Menyoo.asi        ->  menyooStuff/   (the folder carries a suffix)
 *   NativeTrainer.asi ->  NativeTrainer/ (the only shape exact matching caught)
 *
 * So either side may be a prefix of the other. That catches the real naming
 * conventions while still being tight enough that nothing claims `update/` or
 * `x64/` - which share no prefix with any plugin name, and which the caller
 * screens out through protectedPaths regardless.
 *
 * The length floor matters: a two or three character stem would prefix-match
 * half the directories in a game folder.
 */
export function isCompanionFolder(asiBase: string, folder: string): boolean {
  const a = asiBase.toLowerCase();
  const f = folder.toLowerCase();
  if (a.length < 4 || f.length < 4) return a === f;
  return a === f || a.startsWith(f) || f.startsWith(a);
}

const ENGINE_DLL =
  /^(bink2w64|binkawin64|d3dcompiler_\d+|d3dcsx_\d+|dstorage|dstoragecore|fvad|libcurl|libtox|opus|opusenc|steam_api64|steam_api|xcurl|zlib1|turbojpeg|mtlx|oo2core[\w.]*|amd_ags_x64|amd_fidelityfx[\w]*|nvngx[\w]*|gfsdk_[\w.]+|gpuperfapi[\w-]*|nvpmapi[\w.]*|sl\.[\w]+|api-ms-win[\w-]*|msvc[pr]\d+|vcruntime\d+|concrt\d+|ucrtbase|openvr_api|openal32|physx[\w]*|apex_[\w]*|cudart[\w]*|icu[\w]*)\.dll$/i;

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
  if (ENGINE_DLL.test(base)) return false; // never, whatever else matches
  if (base.endsWith('.asi') || base.endsWith('.oiv')) return true;
  if (PROXY_DLL.test(base)) return true;

  const dir = toPosix(path.dirname(rel)).toLowerCase();
  if (MOD_ONLY_DIR.test(dir)) {
    return /\.(dll|cs|cm|lua|pak|ucas|utoc|asi|xml|ini)$/i.test(base);
  }
  return false;
}

/**
 * Find mod files in the game folder that GTArage did not put there.
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
    /*
     * Depth-limited on purpose.
     *
     * The game root is flat, and a mod's own folder is one or two levels at
     * most. But `mods/` on GTA V can mirror the entire game archive tree, so
     * an unbounded walk here would spend tens of seconds enumerating tens of
     * thousands of files that could never be adoption candidates anyway.
     */
    const files = await walk(dir, root === '' ? 0 : 3);
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

  /*
   * An .asi usually comes with a data folder of the same name.
   *
   * ChaosMod is `ChaosMod.asi` plus a `chaosmod/` folder holding its scripts,
   * sounds and overlay; Menyoo and others follow the same convention. Taking
   * only the .asi splits the mod in half: the library holds one file, the
   * data folder stays unmanaged in the game folder forever, and disabling the
   * mod leaves its leftovers behind. Worse, the two halves can then be
   * removed independently.
   *
   * So a loose .asi claims a sibling directory matching its base name.
   */
  const claimSiblingFolder = async (rel: string): Promise<string[]> => {
    const base = path.basename(rel, path.extname(rel));
    const dir = path.dirname(rel) === '.' ? '' : `${path.dirname(rel)}/`;
    const parent = path.join(gamePath, dir);

    let entries;
    try {
      entries = await fs.readdir(parent, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Never claim part of the base game, however the name lines up.
      if (isProtectedish(def.protectedPaths, `${dir}${entry.name}`)) continue;
      if (!isCompanionFolder(base, entry.name)) continue;
      const walked = await walk(path.join(parent, entry.name), 4);
      out.push(...walked.map((f) => toPosix(`${dir}${entry.name}/${f.rel}`)));
    }
    return out;
  };

  // Anything left that is unmistakably a mod becomes its own entry. Only
  // files that passed the evidence bar qualify, so the game's own vendor
  // DLLs are never offered.
  for (const [rel, size] of remaining) {
    if (!evidence.has(rel)) continue;

    // Pull in the mod's own data folder, when it has one.
    let extraFiles: string[] = [];
    let extraBytes = 0;
    if (/\.asi$/i.test(rel)) {
      extraFiles = await claimSiblingFolder(rel);
      for (const f of extraFiles) {
        try {
          extraBytes += (await fs.stat(path.join(gamePath, f))).size;
        } catch {
          // counted for display only
        }
      }
    }

    if (extraFiles.length > 0) {
      groups.push({
        id: `loose-${path.basename(rel).toLowerCase()}`,
        name: path.basename(rel),
        files: [rel, ...extraFiles].sort(),
        bytes: size + extraBytes,
        core: false,
      });
      continue;
    }

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
