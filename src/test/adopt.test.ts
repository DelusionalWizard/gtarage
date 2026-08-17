/**
 * Tests for adopting hand-installed mods.
 *
 * These exist because the first working version offered the *base game's own
 * DLLs* for adoption — `steam_api64.dll`, `nvngx_dlss.dll`, `bink2w64.dll`,
 * `MTLX.dll` — on a real GTA V and Definitive Edition install. Importing one
 * would copy an engine binary into the mod library and let the user "disable"
 * it, breaking the game. The file names below are the real ones observed on
 * disk.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findAdoptable, isCompanionFolder } from '../main/adopt';
import { defaultConfig } from '../main/config';
import type { AppConfig, GameId } from '../shared/types';

/** A fake game folder containing the given relative files. */
async function gameFolder(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-adopt-'));
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x');
  }
  return dir;
}

function config(): AppConfig {
  return defaultConfig(path.join(os.tmpdir(), 'gtarage-adopt-cfg'));
}

/** The vendor DLLs GTA V and Enhanced actually ship at their root. */
const VENDOR_DLLS = [
  'steam_api64.dll',
  'nvngx_dlss.dll',
  'nvngx_dlssg.dll',
  'bink2w64.dll',
  'zlib1.dll',
  'libcurl.dll',
  'XCurl.dll',
  'opus.dll',
  'dstorage.dll',
  'amd_ags_x64.dll',
  'GFSDK_Aftermath_Lib.x64.dll',
  'sl.interposer.dll',
  'oo2core_5_win64.dll',
];

/**
 * The exact list a user reported seeing offered as "mods they added".
 * This is GTA V Legacy's own vendor set, verbatim.
 */
const REPORTED_FALSE_POSITIVES = [
  'bink2w64.dll',
  'd3dcompiler_46.dll',
  'd3dcsx_46.dll',
  'fvad.dll',
  'GFSDK_ShadowLib.win64.dll',
  'GFSDK_TXAA.win64.dll',
  'GFSDK_TXAA_AlphaResolve.win64.dll',
  'GPUPerfAPIDX11-x64.dll',
  'libcurl.dll',
  'libtox.dll',
  'NvPmApi.Core.win64.dll',
  'opus.dll',
  'opusenc.dll',
  'steam_api64.dll',
  'XCurl.dll',
  'zlib1.dll',
];

test('the exact set of engine DLLs a user reported is never offered', async () => {
  const dir = await gameFolder(REPORTED_FALSE_POSITIVES);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(
      groups.map((g) => g.name),
      [],
      `still offering: ${groups.map((g) => g.name).join(', ')}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an engine DLL is refused even sitting inside a mod folder', async () => {
  // Defence in depth: scripts/ normally means "this is a mod", but a vendor
  // library in there is still a vendor library.
  const dir = await gameFolder(['scripts/steam_api64.dll', 'scripts/RealMod.dll']);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(groups.map((g) => g.name), ['RealMod.dll']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the game\'s own vendor DLLs are never offered for adoption', async () => {
  const dir = await gameFolder(VENDOR_DLLS);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(
      groups.map((g) => g.name),
      [],
      `offered engine files: ${groups.map((g) => g.name).join(', ')}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Definitive Edition engine binaries are not offered either', async () => {
  // Gameface/Binaries/Win64 is both the engine folder and a DLL-mod target,
  // so it needs the same protection.
  const dir = await gameFolder([
    'Gameface/Binaries/Win64/MTLX.dll',
    'Gameface/Binaries/Win64/turbojpeg.dll',
    'Gameface/Binaries/Win64/steam_api64.dll',
    'Gameface/Binaries/Win64/api-ms-win-downlevel-kernel32-l2-1-0.dll',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gtasade' as GameId, dir);
    assert.deepEqual(groups.map((g) => g.name), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a hand-installed ScriptHookV is recognised as one tool', async () => {
  const dir = await gameFolder([
    'ScriptHookV.dll',
    'dinput8.dll',
    'NativeTrainer.asi',
    'readme.txt',
    // ...sitting among the game's own files, which must be ignored.
    'steam_api64.dll',
    'bink2w64.dll',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    const shv = groups.find((g) => g.name === 'ScriptHookV');
    assert.ok(shv, `expected ScriptHookV, got: ${groups.map((g) => g.name).join(', ')}`);
    assert.ok(shv.files.includes('ScriptHookV.dll'));
    assert.ok(shv.files.includes('dinput8.dll'), 'its bundled loader comes with it');
    assert.ok(shv.core, 'ScriptHookV is load-bearing');
    assert.ok(
      !groups.some((g) => g.name === 'steam_api64.dll'),
      'the game\'s own DLLs stay out',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a loose .asi is offered, a loose vendor .dll is not', async () => {
  const dir = await gameFolder(['ChaosMod.asi', 'zlib1.dll']);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(groups.map((g) => g.name), ['ChaosMod.asi']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a DLL inside scripts/ is a mod, because only mods create that folder', async () => {
  const dir = await gameFolder(['scripts/MyTrainer.dll', 'zlib1.dll']);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(groups.map((g) => g.name), ['MyTrainer.dll']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a proxy DLL is recognised as an ASI loader wherever it sits', async () => {
  const dir = await gameFolder(['dinput8.dll']);
  try {
    const groups = await findAdoptable(config(), 'gtasa' as GameId, dir);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.name, 'ASI loader');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an empty game folder offers nothing', async () => {
  const dir = await gameFolder([]);
  try {
    assert.deepEqual(await findAdoptable(config(), 'gta5' as GameId, dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an .asi brings its data folder with it', async () => {
  // ChaosMod is ChaosMod.asi plus a chaosmod/ folder of scripts and sounds.
  // Taking only the .asi splits the mod in half: the library gets one file,
  // the data folder stays unmanaged in the game folder, and the two can then
  // be removed independently — which is how a real user lost theirs.
  const dir = await gameFolder([
    'ChaosMod.asi',
    'chaosmod/natives_def.lua',
    'chaosmod/version.txt',
    'chaosmod/scripts/thing.lua',
    'chaosmod/twitchOverlay/index.html',
    // ...and the game around it, which must stay out.
    'steam_api64.dll',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    const chaos = groups.find((g) => g.name === 'ChaosMod.asi');
    assert.ok(chaos, `expected ChaosMod, got: ${groups.map((g) => g.name).join(', ')}`);

    assert.ok(chaos.files.includes('ChaosMod.asi'));
    for (const wanted of [
      'chaosmod/natives_def.lua',
      'chaosmod/version.txt',
      'chaosmod/scripts/thing.lua',
      'chaosmod/twitchOverlay/index.html',
    ]) {
      assert.ok(chaos.files.includes(wanted), `should also claim ${wanted}`);
    }
    assert.ok(!chaos.files.includes('steam_api64.dll'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an .asi with no data folder is unaffected', async () => {
  const dir = await gameFolder(['Simple.asi']);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    assert.deepEqual(groups.map((g) => g.files), [['Simple.asi']]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- companion folders, with the names mods actually ship ------------------
//
// The test above uses `ChaosMod.asi` + `chaosmod/`, which an exact-name match
// satisfies — and that is exactly why the first fix passed review and still
// failed for real users. The distributions are not named that tidily.

test('a versioned plugin still claims its unversioned data folder', async () => {
  // ChaosModV ships ChaosModV.asi beside a plain `chaosmod` folder. Under
  // exact matching the folder was left behind, unmanaged, forever.
  const dir = await gameFolder([
    'ChaosModV.asi',
    'chaosmod/config.ini',
    'chaosmod/scripts/thing.lua',
    'steam_api64.dll',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    const chaos = groups.find((g) => g.name === 'ChaosModV.asi');
    assert.ok(chaos, `expected ChaosModV, got: ${groups.map((g) => g.name).join(', ')}`);
    assert.ok(chaos.files.includes('chaosmod/config.ini'), 'must claim the data folder');
    assert.ok(chaos.files.includes('chaosmod/scripts/thing.lua'));
    assert.ok(!chaos.files.includes('steam_api64.dll'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a plugin claims a data folder that carries a suffix', async () => {
  // Menyoo is the most common example: Menyoo.asi plus menyooStuff/.
  const dir = await gameFolder([
    'Menyoo.asi',
    'menyooStuff/Menyoo.ini',
    'menyooStuff/Spooner/x.xml',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    const menyoo = groups.find((g) => g.name === 'Menyoo.asi');
    assert.ok(menyoo, 'Menyoo should be offered');
    assert.ok(menyoo.files.includes('menyooStuff/Menyoo.ini'), 'must claim menyooStuff');
    assert.ok(menyoo.files.includes('menyooStuff/Spooner/x.xml'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a plugin never claims a base-game folder', async () => {
  // The loosened matching must not let a plugin swallow part of the game.
  const dir = await gameFolder([
    'update.asi',
    'update/x64/dlcpacks/patchday/dlc.rpf',
  ]);
  try {
    const groups = await findAdoptable(config(), 'gta5' as GameId, dir);
    const claimed = groups.flatMap((g) => g.files);
    assert.ok(
      !claimed.some((f) => f.startsWith('update/')),
      `nothing may claim update/, got: ${claimed.join(', ')}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- the matcher itself ----------------------------------------------------

test('the companion matcher accepts the real naming conventions', () => {
  assert.ok(isCompanionFolder('NativeTrainer', 'NativeTrainer'), 'exact');
  assert.ok(isCompanionFolder('ChaosMod', 'chaosmod'), 'casing must not matter');
  assert.ok(isCompanionFolder('ChaosModV', 'chaosmod'), 'version suffix on the plugin');
  assert.ok(isCompanionFolder('Menyoo', 'menyooStuff'), 'suffix on the folder');
});

test('the companion matcher refuses everything else', () => {
  for (const folder of ['update', 'x64', 'BattlEye', 'Redistributables', 'scripts']) {
    assert.ok(!isCompanionFolder('ChaosModV', folder), `${folder} must not match`);
  }
  // Two plugins must never claim each other's data.
  assert.ok(!isCompanionFolder('Menyoo', 'chaosmod'));
  assert.ok(!isCompanionFolder('ChaosModV', 'menyooStuff'));
});

test('short stems fall back to exact matching', () => {
  // Without a length floor a stem this short prefix-matches half a game folder.
  assert.ok(!isCompanionFolder('sh', 'shaders'));
  assert.ok(!isCompanionFolder('x64', 'x64a'));
  assert.ok(isCompanionFolder('x64', 'x64'));
});
