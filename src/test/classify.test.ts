/**
 * Tests for mod classification.
 *
 * Classification decides the deploy root, so getting it wrong does not throw
 * an error -- it puts files somewhere the game never looks and the mod simply
 * does nothing. That silence is why these cases are pinned down here.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyFiles,
  classifyMod,
  repairClassifications,
  repairLayout,
} from '../main/library';
import type { Mod } from '../shared/types';
import { deployRootFor, getGame } from '../shared/games';
import type { GameId, ModKind } from '../shared/types';

/** Build a temp mod folder containing the given (empty) files. */
async function modWith(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-cls-'));
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'x');
  }
  return dir;
}

async function kindOf(files: string[], gameId: GameId): Promise<ModKind> {
  const dir = await modWith(files);
  try {
    return await classifyMod(dir, gameId);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Where a mod of this kind would put a file, relative to the game root. */
function rootFor(kind: ModKind, gameId: GameId): string {
  return deployRootFor(getGame(gameId), kind);
}

test('a proxy DLL loader deploys to the game root, not scripts/', async () => {
  // Ultimate ASI Loader ships dinput8.dll. Windows only loads it if it sits
  // beside the executable; in scripts/ it is inert and every ASI plugin that
  // depends on it silently fails. It was previously classified as `script`.
  const kind = await kindOf(['dinput8.dll'], 'gta5');
  assert.equal(kind, 'asi', 'a proxy DLL must be treated as an ASI loader');
  assert.equal(rootFor(kind, 'gta5'), '', 'must deploy to the game root');
});

test('every proxy DLL name lands at the game root', async () => {
  for (const name of ['dinput8.dll', 'dsound.dll', 'winmm.dll', 'version.dll']) {
    const kind = await kindOf([name], 'gtasa');
    assert.equal(rootFor(kind, 'gtasa'), '', `${name} must deploy to the game root`);
  }
});

test('a .NET script mod still goes to scripts/', async () => {
  const kind = await kindOf(['MyTrainer.dll'], 'gta5');
  assert.equal(kind, 'script');
  assert.equal(rootFor(kind, 'gta5'), 'scripts');
});

test('an .asi plugin goes to the game root', async () => {
  const kind = await kindOf(['ScriptHookVDotNet.asi'], 'gta5');
  assert.equal(kind, 'asi');
  assert.equal(rootFor(kind, 'gta5'), '');
});

test('an archive already using game-relative folders is deployed verbatim', async () => {
  const kind = await kindOf(['scripts/thing.dll', 'readme.txt'], 'gta5');
  assert.equal(kind, 'raw', 'the author already positioned it');
  assert.equal(rootFor(kind, 'gta5'), '');
});

test('an OpenIV package is recognised by its manifest', async () => {
  assert.equal(await kindOf(['assembly.xml', 'content/x.rpf'], 'gta5'), 'oiv');
});

test('CLEO scripts and modloader folders are recognised on the 3D era', async () => {
  assert.equal(await kindOf(['MyScript.cs'], 'gtasa'), 'cleo');
  assert.equal(rootFor('cleo', 'gtasa'), 'CLEO');
  assert.equal(await kindOf(['modloader/mymod/x.dff'], 'gtasa'), 'raw');
});

test('Definitive Edition paks are recognised and land in ~mods', async () => {
  const kind = await kindOf(['MyMod_P.pak', 'MyMod_P.ucas'], 'gtasade');
  assert.equal(kind, 'pak');
  assert.equal(rootFor(kind, 'gtasade'), 'Gameface/Content/Paks/~mods');
});

test('a misfiled library entry is repaired from its stored file list', () => {
  // Exactly the shipped bug: Ultimate ASI Loader stored as `script`, which
  // would deploy dinput8.dll into scripts/ where it never loads.
  const broken = {
    id: 'ual',
    gameId: 'gta5' as GameId,
    name: 'Ultimate ASI Loader',
    kind: 'script' as ModKind,
    version: '9.7.3',
    path: '/library/ual',
    files: ['dinput8.dll'],
    size: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'scripts',
    requires: [],
    core: true,
  } satisfies Mod;

  const changed = repairClassifications([broken]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.from, 'script');
  assert.equal(changed[0]?.to, 'asi');
  assert.equal(broken.kind, 'asi', 'the entry is corrected in place');
  assert.equal(rootFor(broken.kind, 'gta5'), '', 'and now deploys to the game root');
});

test('repair leaves correctly filed mods untouched', () => {
  const fine = {
    id: 'x',
    gameId: 'gta5' as GameId,
    name: 'Some Script',
    kind: 'script' as ModKind,
    version: '1.0',
    path: '/library/x',
    files: ['MyTrainer.dll'],
    size: 1,
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'scripts',
    requires: [],
    core: false,
  } satisfies Mod;

  assert.deepEqual(repairClassifications([fine]), []);
  assert.equal(fine.kind, 'script');
});

test('classifyFiles agrees with classifyMod for the same content', async () => {
  const files = ['dinput8.dll'];
  const dir = await modWith(files);
  try {
    assert.equal(await classifyMod(dir, 'gta5'), classifyFiles(files, 'gta5'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a payload folder beside a readme is unwrapped', async () => {
  // The ScriptHookV layout: HOW_TO_INSTALL.txt + bin/ScriptHookV.dll.
  // Without unwrapping, everything deploys to <game>/bin/ and never loads.
  const dir = await modWith([
    'HOW_TO_INSTALL.txt',
    'bin/ScriptHookV.dll',
    'bin/NativeTrainer.asi',
  ]);
  try {
    const mod = {
      id: 'shv',
      gameId: 'gta5' as GameId,
      name: 'ScriptHookV',
      kind: 'asi' as ModKind,
      version: '1.0',
      path: dir,
      files: ['HOW_TO_INSTALL.txt', 'bin/ScriptHookV.dll', 'bin/NativeTrainer.asi'],
      size: 3,
      addedAt: '2026-01-01T00:00:00.000Z',
      category: 'core',
      requires: [],
      core: true,
    } satisfies Mod;

    assert.equal(await repairLayout(mod), true, 'should hoist the payload');

    const after = (await fs.readdir(dir)).sort();
    assert.ok(after.includes('ScriptHookV.dll'), 'the DLL is now at the mod root');
    assert.ok(!after.includes('bin'), 'the wrapper folder is gone');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a real layout folder is never unwrapped away', async () => {
  // `scripts/` means something; hoisting out of it would break the mod.
  const dir = await modWith(['readme.txt', 'scripts/MyMod.dll']);
  try {
    const mod = {
      id: 'x',
      gameId: 'gta5' as GameId,
      name: 'X',
      kind: 'raw' as ModKind,
      version: '1.0',
      path: dir,
      files: ['readme.txt', 'scripts/MyMod.dll'],
      size: 2,
      addedAt: '2026-01-01T00:00:00.000Z',
      category: 'scripts',
      requires: [],
      core: false,
    } satisfies Mod;

    assert.equal(await repairLayout(mod), false, 'scripts/ must be preserved');
    assert.ok((await fs.readdir(dir)).includes('scripts'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a kind is never chosen that the game does not support', async () => {
  // CLEO does not exist on the Definitive Editions.
  const kind = await kindOf(['script.cs'], 'gtasade');
  assert.ok(
    getGame('gtasade').supportedKinds.includes(kind),
    `${kind} is not supported on gtasade`,
  );
});
