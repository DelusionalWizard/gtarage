/**
 * Dependency detection.
 *
 * Mod pages say "requires ScriptHookV" in prose, if they say it at all, and
 * that prose does not travel with the archive. So Swapmeet works it out from
 * the files themselves.
 *
 * The strongest signal is the PE import table. An `.asi` or `.dll` is a
 * Windows binary, and its import directory literally lists the DLLs it links
 * against -- `ScriptHookV.dll`, `ScriptHookVDotNet3.dll` and so on. That is
 * not a heuristic, it is the loader's own answer to "what does this need?",
 * and reading it takes only a header walk.
 *
 * Managed (.NET) assemblies import almost nothing natively, so for those we
 * fall back to scanning the metadata strings heap, where assembly references
 * appear as plain ASCII. Layout and readme text fill the remaining gaps.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { GameId, Mod, ModDependency } from '../shared/types';
import { GAMES } from '../shared/games';

// --- PE parsing -------------------------------------------------------------

/**
 * Read the names in a PE file's import directory.
 *
 * Walks: MZ header -> PE signature -> optional header (to find the data
 * directories and the section table) -> import directory -> each descriptor's
 * name RVA, mapped back to a file offset through the sections.
 *
 * Returns an empty list for anything that is not a PE, rather than throwing:
 * a mod folder is full of files that are not executables.
 */
export function readPeImports(buf: Buffer): string[] {
  try {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return []; // 'MZ'

    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 24 > buf.length) return [];
    if (buf.readUInt32LE(peOffset) !== 0x00004550) return []; // 'PE\0\0'

    const numberOfSections = buf.readUInt16LE(peOffset + 6);
    const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20);
    const optionalHeaderOffset = peOffset + 24;
    if (optionalHeaderOffset + sizeOfOptionalHeader > buf.length) return [];

    const magic = buf.readUInt16LE(optionalHeaderOffset);
    const isPe32Plus = magic === 0x20b;
    // Data directories start after the fixed part of the optional header.
    const dataDirOffset = optionalHeaderOffset + (isPe32Plus ? 112 : 96);
    // Directory 1 is the import table.
    const importDirOffset = dataDirOffset + 8;
    if (importDirOffset + 8 > buf.length) return [];

    const importRva = buf.readUInt32LE(importDirOffset);
    if (importRva === 0) return [];

    // Section table follows the optional header; used to map RVA -> offset.
    const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
    const sections: Array<{ va: number; size: number; raw: number }> = [];
    for (let i = 0; i < numberOfSections; i++) {
      const off = sectionTableOffset + i * 40;
      if (off + 40 > buf.length) break;
      sections.push({
        va: buf.readUInt32LE(off + 12),
        size: buf.readUInt32LE(off + 8),
        raw: buf.readUInt32LE(off + 20),
      });
    }

    const toOffset = (rva: number): number => {
      for (const s of sections) {
        if (rva >= s.va && rva < s.va + Math.max(s.size, 1)) return s.raw + (rva - s.va);
      }
      return -1;
    };

    const readCString = (offset: number): string => {
      if (offset < 0 || offset >= buf.length) return '';
      let end = offset;
      while (end < buf.length && buf[end] !== 0 && end - offset < 256) end++;
      return buf.toString('latin1', offset, end);
    };

    const names: string[] = [];
    let descriptor = toOffset(importRva);
    if (descriptor < 0) return [];

    // Each IMAGE_IMPORT_DESCRIPTOR is 20 bytes; a zeroed one ends the list.
    for (let i = 0; i < 256; i++) {
      const entry = descriptor + i * 20;
      if (entry + 20 > buf.length) break;
      const nameRva = buf.readUInt32LE(entry + 12);
      if (nameRva === 0) break;
      const name = readCString(toOffset(nameRva));
      if (name) names.push(name);
    }

    return names;
  } catch {
    return [];
  }
}

/**
 * Assembly references from a .NET binary.
 *
 * Rather than parsing the CLI metadata tables properly, this looks for known
 * assembly names as ASCII in the strings heap. For the question being asked
 * -- "does this reference ScriptHookVDotNet?" -- that is sufficient and far
 * less fragile than a partial metadata parser.
 */
function readManagedRefs(buf: Buffer): string[] {
  const found: string[] = [];
  const text = buf.toString('latin1');
  for (const name of ['ScriptHookVDotNet3', 'ScriptHookVDotNet2', 'ScriptHookVDotNet', 'RagePluginHook', 'NAudio', 'LemonUI', 'NativeUI']) {
    if (text.includes(name)) found.push(name);
  }
  return found;
}

// --- capability rules -------------------------------------------------------

interface Rule {
  capability: string;
  label: string;
  essentialId?: string;
  /**
   * Per-game override for which catalog entry supplies this capability.
   *
   * The same need is met by different tools on different titles: an ASI
   * loader comes from Ultimate ASI Loader on the classic games, but on GTA V
   * it arrives bundled inside ScriptHookV, which is why UAL is not offered
   * there at all. Without this, the "install it for me" button would point at
   * an entry the catalog no longer lists for that game.
   */
  essentialByGame?: Partial<Record<GameId, string>>;
  /** Games where this dependency is meaningful. */
  games?: GameId[];
}

const RULES: Record<string, Rule> = {
  // One ScriptHookV download serves both Legacy and Enhanced.
  scripthookv: {
    capability: 'scripthookv',
    label: 'ScriptHookV',
    essentialId: 'scripthookv',
    games: ['gta5', 'gta5e'],
  },
  shvdn: {
    capability: 'shvdn',
    label: 'ScriptHookV .NET',
    essentialId: 'scripthookvdotnet',
    games: ['gta5', 'gta5e'],
  },
  asiloader: {
    capability: 'asiloader',
    label: 'An ASI loader',
    essentialId: 'ultimate-asi-loader',
    // ScriptHookV bundles its own dinput8.dll, so on GTA V it *is* the loader
    // and Ultimate ASI Loader is not offered there at all.
    essentialByGame: { gta5: 'scripthookv', gta5e: 'scripthookv' },
    // The Definitive Editions are Unreal Engine 4 and have no ASI ecosystem.
    games: ['gta3', 'gtavc', 'gtasa', 'gta4', 'gta5', 'gta5e'],
  },
  cleo: {
    capability: 'cleo',
    label: 'CLEO',
    essentialId: 'cleo-redux',
    // Only the 3D era has CLEO. `.cs` means "CLEO script" there, but it is
    // also the extension every C# source file uses, and SHVDN mods for GTA V
    // routinely ship their source -- which used to produce a confident
    // recommendation to install a runtime that game cannot use.
    games: ['gta3', 'gtavc', 'gtasa'],
  },
  modloader: {
    capability: 'modloader',
    label: 'modloader',
    essentialId: 'modloader',
    games: ['gta3', 'gtavc', 'gtasa'],
  },
  openiv: {
    capability: 'openiv',
    label: 'OpenIV',
    essentialId: 'openiv',
    games: ['gta4', 'gta5', 'gta5e'],
  },
  ue4ss: {
    capability: 'ue4ss',
    label: 'UE4SS',
    essentialId: 'ue4ss',
    games: ['gta3de', 'gtavcde', 'gtasade'],
  },
  rph: { capability: 'rph', label: 'RAGE Plugin Hook', games: ['gta5', 'gta5e'] },
  dotnet: { capability: 'dotnet', label: 'The .NET runtime' },
};

/**
 * Every catalog entry Swapmeet would offer as a fix on this game.
 *
 * Exists so a test can assert that each offered fix is something the game's
 * catalogue actually lists. The failure it guards against is silent: a
 * dependency pointing at an entry that is not available for that title leaves
 * an "Install" button which cannot succeed.
 */
export function dependencyFixesFor(gameId: GameId): string[] {
  const out = new Set<string>();
  for (const rule of Object.values(RULES)) {
    if (rule.games && !rule.games.includes(gameId)) continue;
    const provider = rule.essentialByGame?.[gameId] ?? rule.essentialId;
    if (provider) out.add(provider);
  }
  return [...out];
}

function make(
  capability: string,
  reason: string,
  gameId: GameId,
  optional = false,
): ModDependency | null {
  const rule = RULES[capability];
  if (!rule) return null;
  const dep: ModDependency = { capability, label: rule.label, reason };
  // A per-game supplier wins, so the offered fix is one this game can use.
  const provider = rule.essentialByGame?.[gameId] ?? rule.essentialId;
  if (provider) dep.essentialId = provider;
  if (optional) dep.optional = true;
  return dep;
}

/**
 * The files that *are* a given capability.
 *
 * Without this, a tool is detected as depending on itself: ScriptHookVDotNet
 * ships `ScriptHookVDotNet.asi`, whose metadata naturally references the
 * ScriptHookVDotNet assembly, so the scanner concluded that ScriptHookVDotNet
 * requires ScriptHookVDotNet. A mod never needs what it provides.
 */
const PROVIDER_FILES: Record<string, RegExp> = {
  shvdn: /^scripthookvdotnet\d*\.(asi|dll)$/i,
  scripthookv: /^scripthookv\.(dll|asi)$/i,
  // A proxy DLL at the game root *is* the ASI loader.
  asiloader:
    /^(dinput8|dsound|winmm|version|vorbisfile|binkw32|xlive|wininet)\.dll$|ultimate[-_ ]?asi/i,
  cleo: /^cleo(_redux)?\.(asi|dll)$/i,
  modloader: /^modloader\.asi$/i,
  openiv: /^openiv\.(exe|asi|dll)$/i,
  ue4ss: /^(ue4ss|dwmapi)\.dll$/i,
  rph: /^rageplugin(hook)?\.(exe|dll)$/i,
};

/** Capabilities this set of files provides itself. */
function providedCapabilities(files: string[]): Set<string> {
  const provided = new Set<string>();
  for (const rel of files) {
    const base = path.basename(rel);
    for (const [capability, pattern] of Object.entries(PROVIDER_FILES)) {
      if (pattern.test(base)) provided.add(capability);
    }
  }
  return provided;
}

/** Text files worth reading for a stated requirement. */
const README = /(readme|read_me|install|requirements?|_notes)/i;
const TEXT_EXT = /\.(txt|md|nfo|rtf|ini|cfg|log|html?)$/i;

/** Phrases that name a dependency in prose, in the order we prefer to report. */
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/script\s*hook\s*v\s*\.?\s*net|scripthookvdotnet|shvdn/i, 'shvdn'],
  [/script\s*hook\s*v\b|scripthookv/i, 'scripthookv'],
  [/rage\s*plugin\s*hook|ragepluginhook|\bRPH\b/i, 'rph'],
  [/\bopeniv\b/i, 'openiv'],
  [/\bue4ss\b/i, 'ue4ss'],
  [/\bcleo\b/i, 'cleo'],
  [/\bmod\s*loader\b/i, 'modloader'],
  [/asi\s*loader|ultimate\s*asi/i, 'asiloader'],
  [/\.net\s*(framework|runtime)\s*[0-9.]+/i, 'dotnet'],
];

/** Read the first chunk of a file; enough for headers or a readme. */
async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Work out what a mod needs.
 *
 * Evidence is ranked: a PE import beats an assembly reference, which beats a
 * sentence in a readme. Each dependency records the evidence that produced it
 * so the user can see why Swapmeet thinks so, and disagree.
 */
export async function scanDependencies(
  modDir: string,
  files: string[],
  gameId: GameId,
): Promise<ModDependency[]> {
  const found = new Map<string, ModDependency>();
  // Anything this mod supplies itself is not a prerequisite for it.
  const provides = providedCapabilities(files);

  const add = (capability: string, reason: string, optional = false) => {
    const rule = RULES[capability];
    if (rule?.games && !rule.games.includes(gameId)) return;
    if (provides.has(capability)) return;
    if (found.has(capability)) return;
    const dep = make(capability, reason, gameId, optional);
    if (dep) found.set(capability, dep);
  };

  const def = GAMES[gameId];

  for (const rel of files) {
    const lower = rel.toLowerCase();
    const abs = path.join(modDir, rel);

    // --- binaries: read the import table -----------------------------------
    if (/\.(asi|dll)$/i.test(lower)) {
      // An .asi is by definition loaded by an ASI loader.
      if (lower.endsWith('.asi')) {
        add('asiloader', `${path.basename(rel)} is an ASI plugin, which needs a loader to start it.`);
      }

      try {
        // 2 MB covers headers and the metadata of any realistic script mod.
        const head = await readHead(abs, 2 * 1024 * 1024);

        for (const imported of readPeImports(head)) {
          const name = imported.toLowerCase();
          if (name.startsWith('scripthookvdotnet')) {
            add('shvdn', `${path.basename(rel)} imports ${imported}.`);
          } else if (name === 'scripthookv.dll') {
            add('scripthookv', `${path.basename(rel)} imports ${imported}.`);
          } else if (name.startsWith('ragepluginhook')) {
            add('rph', `${path.basename(rel)} imports ${imported}.`);
          } else if (name.startsWith('cleo')) {
            add('cleo', `${path.basename(rel)} imports ${imported}.`);
          }
        }

        for (const ref of readManagedRefs(head)) {
          if (ref.startsWith('ScriptHookVDotNet')) {
            add('shvdn', `${path.basename(rel)} references the ${ref} assembly.`);
            // SHVDN itself is an ASI that needs ScriptHookV underneath.
            add('scripthookv', 'ScriptHookV .NET runs on top of ScriptHookV.');
          } else if (ref === 'RagePluginHook') {
            add('rph', `${path.basename(rel)} references ${ref}.`);
          }
        }
      } catch {
        // Unreadable file: not fatal, just less evidence.
      }
      continue;
    }

    // --- layout signals -----------------------------------------------------
    if (/^cleo\//i.test(lower) || /\.(cs|cm)$/i.test(lower)) {
      add('cleo', `${path.basename(rel)} is a CLEO script.`);
    }
    if (/^modloader\//i.test(lower)) {
      add('modloader', 'The archive is laid out for modloader.');
    }
    if (/^assembly\.xml$/i.test(lower)) {
      add('openiv', 'This is an OpenIV package.');
    }
    if (/\.lua$/i.test(lower) && def.era === 'de') {
      add('ue4ss', `${path.basename(rel)} is a Lua mod, which UE4SS loads.`);
    }
    if (/\.(ytd|yft|ydr|rpf)$/i.test(lower) && def.era === 'hd') {
      add(
        'openiv',
        'Replacement assets are involved, which normally means an OpenIV mods/ folder.',
        true,
      );
    }
  }

  // --- readme text, last and weakest ---------------------------------------
  const textFiles = files.filter((f) => TEXT_EXT.test(f) && (README.test(f) || files.length <= 12));
  for (const rel of textFiles.slice(0, 6)) {
    try {
      const head = await readHead(path.join(modDir, rel), 96 * 1024);
      const text = head.toString('utf8');
      for (const [pattern, capability] of TEXT_PATTERNS) {
        if (pattern.test(text)) {
          add(capability, `${path.basename(rel)} mentions it.`);
        }
      }
    } catch {
      // ignore
    }
  }

  return [...found.values()];
}

/**
 * Resolve which detected dependencies are already covered by the library.
 *
 * Matching is by name against the essentials catalog id and some obvious
 * aliases, because a user may well have installed ScriptHookV by hand under
 * whatever name the archive had.
 */
const SATISFIES: Record<string, RegExp> = {
  scripthookv: /script\s*hook\s*v(?!\s*\.?\s*net)|scripthookv\.dll/i,
  shvdn: /script\s*hook\s*v\s*\.?\s*net|scripthookvdotnet/i,
  asiloader: /asi\s*loader|ultimate\s*asi|dinput8/i,
  cleo: /\bcleo\b/i,
  modloader: /mod\s*loader/i,
  openiv: /\bopeniv\b/i,
  ue4ss: /\bue4ss\b/i,
  rph: /rage\s*plugin\s*hook/i,
  dotnet: /\.net/i,
};

export function annotateSatisfied(deps: ModDependency[], library: Mod[]): ModDependency[] {
  return deps.map((dep) => {
    const pattern = SATISFIES[dep.capability];
    if (!pattern) return dep;
    const hit = library.find(
      (m) => pattern.test(m.name) || m.files.some((f) => pattern.test(path.basename(f))),
    );
    return hit ? { ...dep, satisfiedBy: hit.id } : dep;
  });
}

/** Dependencies a mod still needs, after checking the library. */
export function missingDependencies(mod: Mod, library: Mod[]): ModDependency[] {
  const others = library.filter((m) => m.id !== mod.id);
  // Re-checked here as well as at scan time, so mods indexed by an older
  // build stop claiming to require themselves without needing a re-scan.
  const provides = providedCapabilities(mod.files);
  const selfNamed = new Set(
    Object.entries(SATISFIES)
      .filter(([, pattern]) => pattern.test(mod.name))
      .map(([capability]) => capability),
  );

  return annotateSatisfied(mod.dependencies ?? [], others).filter(
    (d) =>
      !d.satisfiedBy &&
      !d.optional &&
      !provides.has(d.capability) &&
      !selfNamed.has(d.capability),
  );
}
