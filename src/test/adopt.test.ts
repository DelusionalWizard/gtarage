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

import { findAdoptable } from '../main/adopt';
import { defaultConfig } from '../main/config';
import type { AppConfig, GameId } from '../shared/types';

/** A fake game folder containing the given relative files. */
async function gameFolder(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-adopt-'));
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x');
  }
  return dir;
}

function config(): AppConfig {
  return defaultConfig(path.join(os.tmpdir(), 'swapmeet-adopt-cfg'));
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
