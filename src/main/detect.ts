/**
 * Finding the games.
 *
 * Rockstar titles arrive through at least four storefronts and none of them
 * agree on where an install lives, so detection is a union of strategies:
 * parse Steam's library index, read Epic's manifest folder, probe the
 * Rockstar Games registry keys, then fall back to scanning the obvious
 * folders on every fixed drive.
 *
 * Every candidate is confirmed the same way regardless of how it was found:
 * the folder must actually contain the game's signature files. A registry key
 * left behind by an uninstall does not count as an install.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DE_GAME_IDS, GAMES, GAME_ORDER } from '../shared/games';
import type { GameDef, GameId, GameInstall } from '../shared/types';
import { exists } from './fsutil';

const execFileAsync = promisify(execFile);

/** A folder that might hold a game, plus how we came across it. */
interface Candidate {
  path: string;
  source: GameInstall['source'];
  /** Restrict matching to this game when the source already told us which. */
  hint?: GameId;
}

// --- storefront probes ------------------------------------------------------

/** Read Steam's install path out of the registry, with fallbacks. */
async function steamRoot(): Promise<string | null> {
  if (process.platform === 'win32') {
    const fromReg = await regQuery(
      'HKCU\\Software\\Valve\\Steam',
      'SteamPath',
    );
    if (fromReg && (await exists(fromReg))) return fromReg;
  }
  const guesses = [
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    path.join(os.homedir(), '.steam/steam'),
    path.join(os.homedir(), 'Library/Application Support/Steam'),
  ];
  for (const g of guesses) if (await exists(g)) return g;
  return null;
}

/**
 * Steam spreads games across "library folders" listed in a VDF file. We only
 * need the paths, so a targeted regex beats pulling in a VDF parser.
 */
async function steamLibraries(root: string): Promise<string[]> {
  const libs = new Set<string>([root]);
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = await fs.readFile(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      const p = m[1];
      if (p) libs.add(p.replace(/\\\\/g, '\\'));
    }
  } catch {
    // No index file: the base library is still worth checking.
  }
  return [...libs];
}

async function steamCandidates(): Promise<Candidate[]> {
  const root = await steamRoot();
  if (!root) return [];
  const out: Candidate[] = [];
  for (const lib of await steamLibraries(root)) {
    const common = path.join(lib, 'steamapps', 'common');
    if (!(await exists(common))) continue;
    for (const id of GAME_ORDER) {
      for (const folder of GAMES[id].steamFolderNames) {
        const p = path.join(common, folder);
        if (await exists(p)) out.push({ path: p, source: 'steam', hint: id });
      }
    }
  }
  return out;
}

/** Epic records each install as a JSON manifest under ProgramData. */
async function epicCandidates(): Promise<Candidate[]> {
  const dir = 'C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests';
  if (!(await exists(dir))) return [];
  const out: Candidate[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith('.item')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const manifest = JSON.parse(raw) as { InstallLocation?: string };
      if (manifest.InstallLocation) {
        out.push({ path: manifest.InstallLocation, source: 'epic' });
      }
    } catch {
      // A malformed manifest is Epic's problem, not ours.
    }
  }
  return out;
}

/** Query a single registry value. Returns null when absent or non-Windows. */
async function regQuery(key: string, value: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', value]);
    const m = stdout.match(/REG_[A-Z_]+\s+(.+)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function registryCandidates(): Promise<Candidate[]> {
  if (process.platform !== 'win32') return [];
  const out: Candidate[] = [];
  for (const id of GAME_ORDER) {
    for (const key of GAMES[id].registryKeys) {
      for (const valueName of ['InstallFolder', 'InstallLocation', 'Path']) {
        const found = await regQuery(key, valueName);
        if (found && (await exists(found))) {
          out.push({ path: found, source: 'rockstar', hint: id });
        }
      }
    }
  }
  return out;
}

/** Last resort: look in the places people actually install games. */
async function scanCandidates(): Promise<Candidate[]> {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJ') {
      const drive = `${letter}:/`;
      if (!(await exists(drive))) continue;
      roots.push(
        `${drive}Games`,
        `${drive}Program Files/Rockstar Games`,
        `${drive}Program Files (x86)/Rockstar Games`,
        `${drive}Program Files/Epic Games`,
        `${drive}SteamLibrary/steamapps/common`,
      );
    }
  } else {
    roots.push(path.join(os.homedir(), 'Games'));
  }

  const out: Candidate[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push({ path: path.join(root, entry.name), source: 'scan' });
      }
    }
  }
  return out;
}

// --- confirmation -----------------------------------------------------------

/**
 * A folder matches a game when it holds one of that game's signature files.
 *
 * The Definitive Editions are the awkward case: all three ship an identically
 * named `Gameface.exe` at an identical relative path, so the signature check
 * cannot separate them. For those we additionally require the install folder
 * name to name the right city.
 */
export async function matchesGame(dir: string, def: GameDef): Promise<boolean> {
  let sawSignature = false;
  for (const sig of def.signatureFiles) {
    if (await exists(path.join(dir, sig))) {
      sawSignature = true;
      break;
    }
  }
  if (!sawSignature) return false;

  if (def.era === 'de') {
    const folder = path.basename(dir).toLowerCase();
    const named = def.steamFolderNames.some(
      (n) => folder === n.toLowerCase(),
    );
    if (named) return true;
    // Fall back to a keyword unique to this title among the three remasters.
    const keyword = { gta3de: 'iii', gtavcde: 'vice', gtasade: 'andreas' }[
      def.id as 'gta3de' | 'gtavcde' | 'gtasade'
    ];
    return Boolean(keyword && folder.includes(keyword));
  }

  return true;
}

/** Read the file version of the game executable, when Windows will tell us. */
async function exeVersion(dir: string, def: GameDef): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  for (const exe of def.executables) {
    const full = path.join(dir, exe);
    if (!(await exists(full))) continue;
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-Item -LiteralPath '${full.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ]);
      const v = stdout.trim();
      if (v) return v;
    } catch {
      // Version info is a nicety; carry on without it.
    }
  }
  return undefined;
}

/**
 * Run every detection strategy and return one confirmed install per game.
 * Earlier strategies win, which is why the candidate list is ordered
 * storefront-first: a Steam library path is more trustworthy than a guess.
 */
export async function detectGames(): Promise<GameInstall[]> {
  const candidates: Candidate[] = [
    ...(await steamCandidates()),
    ...(await epicCandidates()),
    ...(await registryCandidates()),
    ...(await scanCandidates()),
  ];

  const found = new Map<GameId, GameInstall>();
  for (const cand of candidates) {
    const ids = cand.hint ? [cand.hint] : GAME_ORDER;
    for (const id of ids) {
      if (found.has(id)) continue;
      const def = GAMES[id];
      if (await matchesGame(cand.path, def)) {
        found.set(id, {
          gameId: id,
          path: path.resolve(cand.path),
          source: cand.source,
          version: await exeVersion(cand.path, def),
        });
        break; // one folder is one game
      }
    }
  }

  return GAME_ORDER.filter((id) => found.has(id)).map((id) => found.get(id)!);
}

/**
 * Identify a folder the user picked by hand. Returns every game it could be,
 * best match first, so the UI can ask when a DE folder is ambiguous.
 */
export async function identifyFolder(dir: string): Promise<GameId[]> {
  const out: GameId[] = [];
  for (const id of GAME_ORDER) {
    if (await matchesGame(dir, GAMES[id])) out.push(id);
  }
  if (out.length === 0) {
    // A DE folder with an unexpected name still deserves an offer.
    for (const id of DE_GAME_IDS) {
      if (await exists(path.join(dir, 'Gameface/Binaries/Win64/Gameface.exe'))) {
        out.push(id);
      }
    }
  }
  return out;
}
