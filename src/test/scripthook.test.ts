/**
 * Tests for ScriptHookV setup.
 *
 * The case that matters: taking a copy out of an existing game folder used to
 * hand the importer the game folder *itself*, so setting up ScriptHookV tried
 * to copy a 120 GB GTA V install into the mod library. It presented as the
 * app hanging on "Setting up ScriptHookV...", which is the worst possible
 * symptom for a disk-filling bug — nothing to see until it is too late.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../main/config';
import { findInstalledHook, hookCoverage } from '../main/scripthook';
import type { AppConfig, GameId } from '../shared/types';

/** A fake GTA V folder: ScriptHookV plus a lot of game we must not touch. */
async function gameFolderWithHook(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-shv-'));
  const files = [
    // ScriptHookV's own files.
    'ScriptHookV.dll',
    'dinput8.dll',
    'NativeTrainer.asi',
    'xinput1_4.dll',
    'args.txt',
    // ...and the game sitting around them.
    'GTA5.exe',
    'steam_api64.dll',
    'bink2w64.dll',
    'update/update.rpf',
    'x64/audio/sfx/anything.rpf',
  ];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x');
  }
  return dir;
}

function configWith(gamePath: string): AppConfig {
  const cfg = defaultConfig(path.join(os.tmpdir(), 'swapmeet-shv-cfg'));
  cfg.installs.push({ gameId: 'gta5' as GameId, path: gamePath, source: 'manual' });
  return cfg;
}

test('a game-folder copy names individual files, never the folder', async () => {
  const dir = await gameFolderWithHook();
  try {
    const found = await findInstalledHook(configWith(dir));
    assert.equal(found.length, 1);

    const candidate = found[0]!;
    assert.ok(
      Array.isArray(candidate.files) && candidate.files.length > 0,
      'must list the files to take; handing over the folder copies the whole game',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('only ScriptHookV files are taken, not the game around them', async () => {
  const dir = await gameFolderWithHook();
  try {
    const candidate = (await findInstalledHook(configWith(dir)))[0]!;
    const taken = new Set(candidate.files ?? []);

    for (const wanted of ['ScriptHookV.dll', 'dinput8.dll', 'NativeTrainer.asi']) {
      assert.ok(taken.has(wanted), `should take ${wanted}`);
    }
    for (const forbidden of ['GTA5.exe', 'steam_api64.dll', 'bink2w64.dll', 'update/update.rpf']) {
      assert.ok(!taken.has(forbidden), `must never take ${forbidden}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a game folder without ScriptHookV offers nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-shv-'));
  try {
    await fs.writeFile(path.join(dir, 'GTA5.exe'), 'x');
    assert.deepEqual(await findInstalledHook(configWith(dir)), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('coverage splits games into those that have the hook and those that do not', () => {
  const cfg = defaultConfig(path.join(os.tmpdir(), 'swapmeet-shv-cfg'));
  cfg.installs.push(
    { gameId: 'gta5' as GameId, path: 'C:/gta5', source: 'manual' },
    { gameId: 'gta5e' as GameId, path: 'C:/gta5e', source: 'manual' },
  );
  cfg.mods.push({
    id: 'shv',
    gameId: 'gta5' as GameId,
    name: 'ScriptHookV',
    kind: 'asi',
    version: '1.0',
    path: '/library/shv',
    files: ['ScriptHookV.dll'],
    size: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'core',
    requires: [],
    core: true,
  });

  const { missing, present } = hookCoverage(cfg);
  assert.deepEqual(present, ['gta5']);
  assert.deepEqual(missing, ['gta5e']);
});
