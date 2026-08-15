/**
 * The universal game registry.
 *
 * Everything Swapmeet knows about a specific Grand Theft Auto title lives in
 * this one table. Adding a new title -- or a re-release with a different
 * folder layout -- should mean adding an entry here and nothing else.
 *
 * The important field is `deployRoots`: it maps a mod kind onto the folder
 * inside the game directory where that kind of mod actually has to live. The
 * 3D-era games (III / Vice City / San Andreas) use CLEO and modloader; the
 * HD-era games (IV / V) use ASI plugins, script hooks and an OpenIV `mods`
 * folder. Keeping that difference as data rather than as branching code is
 * what lets one deployment engine serve all six titles.
 */

import type { GameDef, GameId, ModKind } from './types';

/** Shared across the 3D-era titles, which all use the same modding stack. */
const ERA_3D_KINDS: ModKind[] = ['asi', 'cleo', 'modloader', 'graphics', 'raw'];

export const GAMES: Record<GameId, GameDef> = {
  gta3: {
    id: 'gta3',
    name: 'Grand Theft Auto III',
    shortName: 'GTA III',
    era: '3d',
    executables: ['gta3.exe'],
    signatureFiles: ['gta3.exe', 'data/gta3.dat'],
    steamAppIds: [12100],
    steamFolderNames: ['Grand Theft Auto 3'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA3'],
    deployRoots: {
      asi: '',
      cleo: 'CLEO',
      modloader: 'modloader',
      graphics: '',
      raw: '',
    },
    supportedKinds: [...ERA_3D_KINDS],
    protectedPaths: ['gta3.exe', 'models', 'anim', 'audio'],
    savePaths: ['GTA3 User Files'],
    graphicsFiles: [
      { base: 'documents', rel: 'GTA3 User Files/gta3.set', label: 'Settings' },
    ],
    hasOnline: false,
    notes: 'Needs an ASI loader (Ultimate ASI Loader) for .asi plugins. CLEO 3 and modloader both work.',
  },

  gtavc: {
    id: 'gtavc',
    name: 'Grand Theft Auto: Vice City',
    shortName: 'Vice City',
    era: '3d',
    executables: ['gta-vc.exe', 'gta_vc.exe'],
    signatureFiles: ['gta-vc.exe', 'gta_vc.exe', 'data/gta_vc.dat'],
    steamAppIds: [12110],
    steamFolderNames: ['Grand Theft Auto Vice City'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA Vice City'],
    deployRoots: {
      asi: '',
      cleo: 'CLEO',
      modloader: 'modloader',
      graphics: '',
      raw: '',
    },
    supportedKinds: [...ERA_3D_KINDS],
    protectedPaths: ['gta-vc.exe', 'models', 'anim', 'audio'],
    savePaths: ['GTA Vice City User Files'],
    graphicsFiles: [
      { base: 'documents', rel: 'GTA Vice City User Files/gta_vc.set', label: 'Settings' },
    ],
    hasOnline: false,
    notes: 'Needs an ASI loader for .asi plugins. CLEO for Vice City and modloader both work.',
  },

  gtasa: {
    id: 'gtasa',
    name: 'Grand Theft Auto: San Andreas',
    shortName: 'San Andreas',
    era: '3d',
    executables: ['gta_sa.exe', 'gta-sa.exe'],
    signatureFiles: ['gta_sa.exe', 'gta-sa.exe', 'data/gta.dat'],
    steamAppIds: [12120],
    steamFolderNames: ['Grand Theft Auto San Andreas'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA San Andreas'],
    deployRoots: {
      asi: '',
      cleo: 'CLEO',
      modloader: 'modloader',
      graphics: '',
      raw: '',
    },
    supportedKinds: [...ERA_3D_KINDS],
    protectedPaths: ['gta_sa.exe', 'models', 'anim', 'audio'],
    savePaths: ['GTA San Andreas User Files'],
    graphicsFiles: [
      { base: 'documents', rel: 'GTA San Andreas User Files/gta_sa.set', label: 'Settings' },
    ],
    hasOnline: false,
    notes: 'modloader is strongly preferred over replacing files inside models/gta3.img. The Steam 3.0 build needs a downgrade for most classic mods.',
  },

  // --- Definitive Edition remasters -------------------------------------
  //
  // The DE trilogy is not the 3D-era engine with new textures: it is the
  // classic game logic hosted inside Unreal Engine 4. That changes modding
  // completely. There is no CLEO and no modloader; mods ship as UE4 `.pak`
  // (plus `.ucas`/`.utoc` for IO-store builds) and are loaded by dropping
  // them into a `~mods` folder, where the tilde makes them sort after — and
  // therefore override — the base game chunks. Script mods use UE4SS and
  // live next to the executable rather than at the install root.
  //
  // Steam app ids below are best-effort; detection never trusts them alone,
  // it confirms the folder by signature file.

  gta3de: {
    id: 'gta3de',
    name: 'Grand Theft Auto III - Definitive Edition',
    shortName: 'GTA III DE',
    era: 'de',
    executables: ['Gameface/Binaries/Win64/Gameface.exe'],
    signatureFiles: ['Gameface/Binaries/Win64/Gameface.exe', 'Gameface/Content/Paks'],
    steamAppIds: [1547000],
    steamFolderNames: [
      'Grand Theft Auto III - Definitive Edition',
      'GTA III - Definitive Edition',
    ],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA III Definitive Edition'],
    deployRoots: {
      pak: 'Gameface/Content/Paks/~mods',
      lua: 'Gameface/Binaries/Win64/ue4ss/Mods',
      asi: 'Gameface/Binaries/Win64',
      graphics: 'Gameface/Binaries/Win64',
      raw: '',
    },
    supportedKinds: ['pak', 'lua', 'asi', 'graphics', 'raw'],
    protectedPaths: [
      'Gameface/Binaries/Win64/Gameface.exe',
      'Gameface/Content/Paks/pakchunk*',
    ],
    savePaths: ['Rockstar Games/GTA III Definitive Edition'],
    graphicsFiles: [
      { base: 'localappdata', rel: 'Gameface/Saved/Config/WindowsNoEditor/GameUserSettings.ini', label: 'Graphics settings' },
    ],
    hasOnline: false,
    notes: 'Unreal Engine 4. Mods are .pak files dropped into Gameface/Content/Paks/~mods; script mods need UE4SS. Classic CLEO and modloader mods do not work here.',
  },

  gtavcde: {
    id: 'gtavcde',
    name: 'Grand Theft Auto: Vice City - Definitive Edition',
    shortName: 'Vice City DE',
    era: 'de',
    executables: ['Gameface/Binaries/Win64/Gameface.exe'],
    signatureFiles: ['Gameface/Binaries/Win64/Gameface.exe', 'Gameface/Content/Paks'],
    steamAppIds: [1547010],
    steamFolderNames: [
      'Grand Theft Auto Vice City - Definitive Edition',
      'GTA Vice City - Definitive Edition',
    ],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA Vice City Definitive Edition'],
    deployRoots: {
      pak: 'Gameface/Content/Paks/~mods',
      lua: 'Gameface/Binaries/Win64/ue4ss/Mods',
      asi: 'Gameface/Binaries/Win64',
      graphics: 'Gameface/Binaries/Win64',
      raw: '',
    },
    supportedKinds: ['pak', 'lua', 'asi', 'graphics', 'raw'],
    protectedPaths: [
      'Gameface/Binaries/Win64/Gameface.exe',
      'Gameface/Content/Paks/pakchunk*',
    ],
    savePaths: ['Rockstar Games/GTA Vice City Definitive Edition'],
    graphicsFiles: [
      { base: 'localappdata', rel: 'Gameface/Saved/Config/WindowsNoEditor/GameUserSettings.ini', label: 'Graphics settings' },
    ],
    hasOnline: false,
    notes: 'Unreal Engine 4. Mods are .pak files in Gameface/Content/Paks/~mods; script mods need UE4SS.',
  },

  gtasade: {
    id: 'gtasade',
    name: 'Grand Theft Auto: San Andreas - Definitive Edition',
    shortName: 'San Andreas DE',
    era: 'de',
    executables: ['Gameface/Binaries/Win64/Gameface.exe'],
    signatureFiles: ['Gameface/Binaries/Win64/Gameface.exe', 'Gameface/Content/Paks'],
    steamAppIds: [1547020],
    steamFolderNames: [
      'Grand Theft Auto San Andreas - Definitive Edition',
      'GTA San Andreas - Definitive Edition',
    ],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTA San Andreas Definitive Edition'],
    deployRoots: {
      pak: 'Gameface/Content/Paks/~mods',
      lua: 'Gameface/Binaries/Win64/ue4ss/Mods',
      asi: 'Gameface/Binaries/Win64',
      graphics: 'Gameface/Binaries/Win64',
      raw: '',
    },
    supportedKinds: ['pak', 'lua', 'asi', 'graphics', 'raw'],
    protectedPaths: [
      'Gameface/Binaries/Win64/Gameface.exe',
      'Gameface/Content/Paks/pakchunk*',
    ],
    savePaths: ['Rockstar Games/GTA San Andreas Definitive Edition'],
    graphicsFiles: [
      { base: 'localappdata', rel: 'Gameface/Saved/Config/WindowsNoEditor/GameUserSettings.ini', label: 'Graphics settings' },
    ],
    hasOnline: false,
    notes: 'Unreal Engine 4. Mods are .pak files in Gameface/Content/Paks/~mods; script mods need UE4SS.',
  },

  gta4: {
    id: 'gta4',
    name: 'Grand Theft Auto IV / Episodes from Liberty City',
    shortName: 'GTA IV',
    era: 'hd',
    executables: ['GTAIV.exe', 'EFLC.exe', 'PlayGTAIV.exe'],
    launchWith: ['PlayGTAIV.exe', 'GTAIV.exe', 'EFLC.exe'],
    signatureFiles: ['GTAIV.exe', 'EFLC.exe'],
    steamAppIds: [12210, 12220],
    steamFolderNames: ['Grand Theft Auto IV'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto IV'],
    deployRoots: {
      asi: '',
      script: 'scripts',
      graphics: '',
      raw: '',
    },
    supportedKinds: ['asi', 'script', 'graphics', 'raw'],
    protectedPaths: ['GTAIV.exe', 'EFLC.exe', 'pc/data', 'pc/models'],
    savePaths: ['Rockstar Games/GTA IV/savegames'],
    graphicsFiles: [
      { base: 'game', rel: 'commandline.txt', label: 'Launch options' },
    ],
    hasOnline: true,
    notes: 'The Complete Edition changed the executable and broke many older ASI plugins. Scripts go in scripts/ next to the exe.',
  },

  gta5: {
    id: 'gta5',
    name: 'Grand Theft Auto V (Legacy)',
    shortName: 'GTA V',
    era: 'hd',
    executables: ['GTA5.exe', 'PlayGTAV.exe', 'GTAVLauncher.exe'],
    // GTA5.exe refuses to start on its own with ERR_NO_LAUNCHER.
    launchWith: ['PlayGTAV.exe', 'GTAVLauncher.exe', 'GTA5.exe'],
    signatureFiles: ['GTA5.exe'],
    steamAppIds: [271590],
    steamFolderNames: ['Grand Theft Auto V'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V'],
    deployRoots: {
      asi: '',
      script: 'scripts',
      oiv: 'mods',
      replace: 'mods',
      graphics: '',
      raw: '',
    },
    supportedKinds: ['asi', 'script', 'oiv', 'replace', 'graphics', 'raw'],
    protectedPaths: ['GTA5.exe', 'PlayGTAV.exe', 'x64', 'update', 'Redistributables'],
    savePaths: ['Rockstar Games/GTA V/Profiles'],
    graphicsFiles: [
      { base: 'documents', rel: 'Rockstar Games/GTA V/settings.xml', label: 'Graphics settings' },
      { base: 'game', rel: 'commandline.txt', label: 'Launch options' },
    ],
    hasOnline: true,
    notes: 'Never take modded files online. Replacements belong in mods/ so the vanilla archives stay untouched for GTA Online.',
  },

  gta5e: {
    id: 'gta5e',
    name: 'Grand Theft Auto V Enhanced',
    shortName: 'GTA V Enhanced',
    era: 'hd',
    executables: ['GTA5_Enhanced.exe', 'PlayGTAV.exe'],
    launchWith: ['PlayGTAV.exe', 'GTA5_Enhanced.exe'],
    signatureFiles: ['GTA5_Enhanced.exe'],
    steamAppIds: [3240220],
    steamFolderNames: ['Grand Theft Auto V Enhanced'],
    registryKeys: ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTAV Enhanced'],
    deployRoots: {
      asi: '',
      script: 'scripts',
      oiv: 'mods',
      replace: 'mods',
      graphics: '',
      raw: '',
    },
    supportedKinds: ['asi', 'script', 'oiv', 'replace', 'graphics', 'raw'],
    protectedPaths: ['GTA5_Enhanced.exe', 'PlayGTAV.exe', 'x64', 'update'],
    savePaths: ['Rockstar Games/GTA V Enhanced/Profiles'],
    graphicsFiles: [
      { base: 'documents', rel: 'Rockstar Games/GTA V Enhanced/settings.xml', label: 'Graphics settings' },
      { base: 'game', rel: 'commandline.txt', label: 'Launch options' },
    ],
    hasOnline: true,
    notes: 'Enhanced ships with BattlEye. Modding it is riskier than Legacy and anything that touches online is a ban. Keep a vanilla-locked profile for online play.',
  },
};

/** Stable display order for the game switcher: newest era first. */
export const GAME_ORDER: GameId[] = [
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

/** Human label for an era, used as a section heading in the game switcher. */
export const ERA_LABELS: Record<GameDef['era'], string> = {
  hd: 'HD era',
  de: 'Definitive Edition',
  '3d': '3D era (original)',
};

/**
 * The three Definitive Editions ship the same `Gameface.exe` at the same
 * relative path, so a signature-file check alone cannot tell them apart.
 * Detection has to fall back to the install folder name.
 */
export const DE_GAME_IDS: GameId[] = ['gta3de', 'gtavcde', 'gtasade'];

export function getGame(id: GameId): GameDef {
  const def = GAMES[id];
  if (!def) throw new Error(`Unknown game id: ${id}`);
  return def;
}

export function isGameId(value: string): value is GameId {
  return Object.prototype.hasOwnProperty.call(GAMES, value);
}

/**
 * Resolve the game-relative folder a mod of this kind deploys into.
 * Falls back to the game root for kinds the title does not special-case.
 */
export function deployRootFor(def: GameDef, kind: ModKind): string {
  return def.deployRoots[kind] ?? '';
}
