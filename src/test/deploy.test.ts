/**
 * The filesystem half of deployment, against a real temp game folder.
 *
 * The planner tests cover what Swapmeet *decides*; these cover what it
 * actually does to a disk. The invariants under test are the ones that make
 * the tool safe to try: a displaced game file is never lost, a swap only
 * moves the difference, and undeploy puts the folder back byte for byte.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deployProfile,
  desiredFiles,
  readManifest,
  undeployAll,
  verifyGameFolder,
} from '../main/deploy';
import { initConfig, defaultConfig } from '../main/config';
import type { AppConfig, GameId, Mod, Profile } from '../shared/types';

// --- harness ---------------------------------------------------------------

interface Harness {
  root: string;
  config: AppConfig;
  gamePath: string;
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-deploy-'));
  initConfig(root);
  const config = defaultConfig(root);
  const gamePath = path.join(root, 'game');
  await fs.mkdir(gamePath, { recursive: true });
  return { root, config, gamePath };
}

async function cleanup(h: Harness): Promise<void> {
  await fs.rm(h.root, { recursive: true, force: true });
}

/** Write a file with content, creating parents. */
async function put(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Create a mod in the library with the given mod-relative files.
 * Returns the Mod record the engine expects.
 */
async function makeMod(
  h: Harness,
  id: string,
  files: Record<string, string>,
  over: Partial<Mod> = {},
): Promise<Mod> {
  const modPath = path.join(h.config.libraryPath, 'gta5', id, 'content');
  for (const [rel, content] of Object.entries(files)) {
    await put(path.join(modPath, rel), content);
  }
  return {
    id,
    gameId: 'gta5' as GameId,
    name: id,
    kind: 'replace',
    version: '1.0',
    path: modPath,
    files: Object.keys(files),
    size: Object.values(files).reduce((n, c) => n + c.length, 0),
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'test',
    requires: [],
    core: false,
    ...over,
  };
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    gameId: 'gta5' as GameId,
    name: 'Test',
    order: [],
    enabled: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    vanillaLock: false,
    ...over,
  };
}

async function read(abs: string): Promise<string> {
  return fs.readFile(abs, 'utf8');
}

async function present(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

// --- the round trip --------------------------------------------------------

test('deploy lands files at their deploy roots and records a manifest', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const m = await makeMod(h, 'trafficpack', {
    'common/data/handling.meta': 'traffic-handling',
  });
  const p = profile({ order: [m.id], enabled: [m.id] });

  const result = await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  assert.equal(result.added, 1);
  assert.equal(result.problems.length, 0, result.problems.join('; '));

  // `replace` deploys under mods/ for GTA V.
  const landed = path.join(h.gamePath, 'mods/common/data/handling.meta');
  assert.equal(await read(landed), 'traffic-handling');

  const manifest = await readManifest(h.config, 'gta5');
  assert.equal(manifest?.files.length, 1);
  assert.equal(manifest?.files[0]?.target, 'mods/common/data/handling.meta');
  assert.equal(manifest?.files[0]?.modId, 'trafficpack');
});

test('a deployed file is a hard link, not a copy, on one volume', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const m = await makeMod(h, 'linked', { 'a.meta': 'shared-bytes' });
  const p = profile({ order: [m.id], enabled: [m.id] });
  await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  const src = path.join(m.path, 'a.meta');
  const dest = path.join(h.gamePath, 'mods/a.meta');
  const [a, b] = await Promise.all([fs.stat(src), fs.stat(dest)]);

  // Same inode: the deploy cost no extra bytes.
  assert.equal(a.ino, b.ino, 'deployed file should share an inode with the library copy');
  assert.ok(a.nlink >= 2, 'library file should have a second directory entry');
});

test('displacing a real game file shelves the original and undeploy restores it', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  // A genuine game file that a mod will overwrite.
  const target = path.join(h.gamePath, 'mods/common/data/handling.meta');
  await put(target, 'VANILLA-ORIGINAL');

  const m = await makeMod(h, 'handling', {
    'common/data/handling.meta': 'MODDED',
  });
  const p = profile({ order: [m.id], enabled: [m.id] });

  await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);
  assert.equal(await read(target), 'MODDED');

  const manifest = await readManifest(h.config, 'gta5');
  const entry = manifest?.files[0];
  assert.ok(entry?.backup, 'the displaced original must be recorded in the manifest');
  assert.equal(await read(entry!.backup!), 'VANILLA-ORIGINAL');

  const problems = await undeployAll(h.config, 'gta5', h.gamePath);
  assert.deepEqual(problems, []);
  assert.equal(
    await read(target),
    'VANILLA-ORIGINAL',
    'undeploy must restore the game file byte for byte',
  );
});

test('undeploy leaves the game folder exactly as it was found', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  await put(path.join(h.gamePath, 'GTA5.exe'), 'exe');
  await put(path.join(h.gamePath, 'mods/common/data/handling.meta'), 'VANILLA');

  const before = await snapshot(h.gamePath);

  const a = await makeMod(h, 'a', { 'common/data/handling.meta': 'A' });
  const b = await makeMod(h, 'b', { 'scripts/thing.dll': 'B' }, { kind: 'script' });
  const p = profile({ order: [a.id, b.id], enabled: [a.id, b.id] });

  await deployProfile(h.config, 'gta5', h.gamePath, p, [a, b]);
  await undeployAll(h.config, 'gta5', h.gamePath);

  assert.deepEqual(await snapshot(h.gamePath), before);
});

/** Map of every relative path under root to its content, for exact comparison. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = await read(abs);
    }
  }
  await walk(root);
  return out;
}

test('the load order winner is the file that actually lands on disk', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const first = await makeMod(h, 'first', { 'common/data/handling.meta': 'FIRST' });
  const second = await makeMod(h, 'second', { 'common/data/handling.meta': 'SECOND' });

  const p = profile({ order: ['first', 'second'], enabled: ['first', 'second'] });

  // The planner's answer...
  const desired = desiredFiles(p, [first, second]);
  assert.equal(desired.get('mods/common/data/handling.meta')?.modId, 'second');

  // ...must equal what is on disk.
  await deployProfile(h.config, 'gta5', h.gamePath, p, [first, second]);
  assert.equal(
    await read(path.join(h.gamePath, 'mods/common/data/handling.meta')),
    'SECOND',
    'the mod lower in the load order must win on disk too',
  );
});

test('swapping profiles only moves the difference', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const shared = await makeMod(h, 'shared', { 'shared.meta': 'SHARED' });
  const onlyA = await makeMod(h, 'onlyA', { 'a.meta': 'A' });
  const onlyB = await makeMod(h, 'onlyB', { 'b.meta': 'B' });
  const mods = [shared, onlyA, onlyB];

  const pa = profile({ id: 'pa', order: ['shared', 'onlyA'], enabled: ['shared', 'onlyA'] });
  const pb = profile({ id: 'pb', order: ['shared', 'onlyB'], enabled: ['shared', 'onlyB'] });

  await deployProfile(h.config, 'gta5', h.gamePath, pa, mods);
  const sharedPath = path.join(h.gamePath, 'mods/shared.meta');
  const inoBefore = (await fs.stat(sharedPath)).ino;

  const result = await deployProfile(h.config, 'gta5', h.gamePath, pb, mods);

  assert.equal(result.kept, 1, 'the shared file should be kept, not re-linked');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);

  // Untouched means untouched: same inode, never deleted and recreated.
  assert.equal((await fs.stat(sharedPath)).ino, inoBefore);
  assert.ok(!(await present(path.join(h.gamePath, 'mods/a.meta'))), 'A should be gone');
  assert.equal(await read(path.join(h.gamePath, 'mods/b.meta')), 'B');
});

test('a vanilla-locked profile removes everything and deploys nothing', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const m = await makeMod(h, 'trainer', { 'trainer.asi': 'ASI' }, { kind: 'asi' });
  const modded = profile({ id: 'modded', order: [m.id], enabled: [m.id] });
  const locked = profile({ id: 'locked', vanillaLock: true });

  await deployProfile(h.config, 'gta5', h.gamePath, modded, [m]);
  assert.ok(await present(path.join(h.gamePath, 'trainer.asi')));

  const result = await deployProfile(h.config, 'gta5', h.gamePath, locked, [m]);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 1);
  assert.ok(
    !(await present(path.join(h.gamePath, 'trainer.asi'))),
    'the vanilla lock must leave nothing behind',
  );
});

test('mods aimed at protected game files are refused', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  await put(path.join(h.gamePath, 'GTA5.exe'), 'REAL-EXE');

  // A hostile or broken archive aimed straight at the executable.
  const bad = await makeMod(h, 'bad', { 'GTA5.exe': 'TROJAN' }, { kind: 'asi' });
  const p = profile({ order: [bad.id], enabled: [bad.id] });

  const result = await deployProfile(h.config, 'gta5', h.gamePath, p, [bad]);

  assert.equal(await read(path.join(h.gamePath, 'GTA5.exe')), 'REAL-EXE');
  assert.equal(result.added, 0);
  assert.ok(result.problems.some((p) => /GTA5\.exe/i.test(p)));
});

test('a normal mod is not mistaken for a protected path by prefix', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  // GTA V protects 'x64' and 'update'. These files merely start with those
  // letters and are perfectly ordinary mod files.
  const m = await makeMod(
    h,
    'prefixy',
    { 'x64_textures.asi': 'FINE', 'updater.dll': 'ALSO FINE' },
    { kind: 'asi' },
  );
  const p = profile({ order: [m.id], enabled: [m.id] });

  const result = await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  assert.deepEqual(result.problems, [], 'ordinary files must not be treated as protected');
  assert.equal(result.added, 2);
  assert.ok(await present(path.join(h.gamePath, 'x64_textures.asi')));
  assert.ok(await present(path.join(h.gamePath, 'updater.dll')));
});

test('verify finds a hand-installed stray file but not deployed ones', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const m = await makeMod(h, 'ours', { 'ours.asi': 'OURS' }, { kind: 'asi' });
  const p = profile({ order: [m.id], enabled: [m.id] });
  await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  // Something the user dropped in by hand, which Swapmeet did not deploy.
  await put(path.join(h.gamePath, 'stray.asi'), 'STRAY');

  const report = await verifyGameFolder(h.config, 'gta5', h.gamePath);
  assert.ok(report.orphans.includes('stray.asi'), 'a manual install should be reported');
  assert.ok(!report.orphans.includes('ours.asi'), 'our own file is not an orphan');
  assert.equal(report.clean, false);
});

test('verify reports a deployed file that vanished', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const m = await makeMod(h, 'ours', { 'ours.asi': 'OURS' }, { kind: 'asi' });
  const p = profile({ order: [m.id], enabled: [m.id] });
  await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  await fs.rm(path.join(h.gamePath, 'ours.asi'));

  const report = await verifyGameFolder(h.config, 'gta5', h.gamePath);
  assert.deepEqual(report.missing, ['ours.asi']);
});

test('a failed undeploy keeps the manifest so the displaced file is not orphaned', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const target = path.join(h.gamePath, 'mods/common/data/handling.meta');
  await put(target, 'VANILLA-ORIGINAL');

  const m = await makeMod(h, 'handling', { 'common/data/handling.meta': 'MODDED' });
  const p = profile({ order: [m.id], enabled: [m.id] });
  await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  const manifest = await readManifest(h.config, 'gta5');
  const backup = manifest!.files[0]!.backup!;

  // Simulate a file we cannot remove: the undeploy will fail for this entry.
  // (A locked file in the real world; here, a directory in its place.)
  await fs.rm(target);
  await fs.mkdir(target, { recursive: true });
  await put(path.join(target, 'held.bin'), 'x');

  const problems = await undeployAll(h.config, 'gta5', h.gamePath);
  assert.ok(problems.length > 0, 'the undeploy should report a problem');

  // The displaced vanilla file still exists...
  assert.equal(await read(backup), 'VANILLA-ORIGINAL');

  // ...and the manifest that says where it belongs must NOT have been thrown
  // away, or the only record of how to restore it is gone forever.
  const after = await readManifest(h.config, 'gta5');
  assert.ok(
    after,
    'the manifest must survive a partial undeploy so the user can retry',
  );
});

test('a mid-deploy failure still records the displaced original', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const target = path.join(h.gamePath, 'mods/thing.meta');
  await put(target, 'VANILLA-ORIGINAL');

  // A mod whose source file does not exist: linkOrCopy will throw *after*
  // the real game file has already been moved to the shelf.
  const m = await makeMod(h, 'broken', { 'thing.meta': 'x' });
  await fs.rm(path.join(m.path, 'thing.meta'));

  const p = profile({ order: [m.id], enabled: [m.id] });
  const result = await deployProfile(h.config, 'gta5', h.gamePath, p, [m]);

  assert.ok(result.problems.length > 0, 'the failure should be reported');

  // Whatever happened, the user's original file must still be recoverable:
  // either left in place, or shelved AND recorded in the manifest.
  const manifest = await readManifest(h.config, 'gta5');
  const recorded = manifest?.files.find((f) => f.target === 'mods/thing.meta');

  if (await present(target)) {
    assert.equal(await read(target), 'VANILLA-ORIGINAL');
  } else {
    assert.ok(
      recorded?.backup,
      'a displaced file must be recorded in the manifest, or it is lost',
    );
    assert.equal(await read(recorded!.backup!), 'VANILLA-ORIGINAL');
  }
});

// --- companion folders -----------------------------------------------------
//
// The layout that keeps breaking in real use. ChaosMod, Menyoo and the various
// trainers all ship a loose `.asi` plus a folder of data beside it, and the
// folder is not optional - without it the plugin loads and immediately fails.
// Reported repeatedly as "the folder does not come back" and "the asi does not
// get put back", so the whole round trip is asserted here, not just the deploy.

const CHAOS = {
  'ChaosMod.asi': 'plugin binary',
  'chaosmod/config.ini': 'settings',
  'chaosmod/effects/nested.dat': 'deeply nested data',
  'chaosmod/twitch/auth.txt': 'more data',
};

test('a mod with a companion folder deploys every file, not just the asi', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const mod = await makeMod(h, 'chaos', CHAOS, { kind: 'asi' });
  h.config.mods = [mod];
  const p = profile({ order: ['chaos'], enabled: ['chaos'] });
  h.config.profiles = [p];

  await deployProfile(h.config, 'gta5', h.gamePath, p, [mod]);

  for (const rel of Object.keys(CHAOS)) {
    assert.ok(
      await present(path.join(h.gamePath, rel)),
      `${rel} should have been deployed`,
    );
  }
});

test('undeploying a mod with a companion folder leaves nothing behind', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const before = await snapshot(h.gamePath);

  const mod = await makeMod(h, 'chaos', CHAOS, { kind: 'asi' });
  h.config.mods = [mod];
  const p = profile({ order: ['chaos'], enabled: ['chaos'] });
  const vanilla = profile({ id: 'v', name: 'Vanilla', vanillaLock: true });
  h.config.profiles = [p, vanilla];

  await deployProfile(h.config, 'gta5', h.gamePath, p, [mod]);
  await deployProfile(h.config, 'gta5', h.gamePath, vanilla, [mod]);

  // The folder itself must go too, not just the files inside it: an empty
  // `chaosmod/` left in the game folder is exactly the litter people report.
  assert.ok(
    !(await present(path.join(h.gamePath, 'chaosmod'))),
    'the companion folder should be gone entirely',
  );
  assert.deepEqual(
    await snapshot(h.gamePath),
    before,
    'the game folder should be exactly as it was found',
  );
});

test('a companion folder comes back when the profile is applied again', async (t) => {
  const h = await makeHarness();
  t.after(() => cleanup(h));

  const mod = await makeMod(h, 'chaos', CHAOS, { kind: 'asi' });
  h.config.mods = [mod];
  const p = profile({ order: ['chaos'], enabled: ['chaos'] });
  const vanilla = profile({ id: 'v', name: 'Vanilla', vanillaLock: true });
  h.config.profiles = [p, vanilla];

  await deployProfile(h.config, 'gta5', h.gamePath, p, [mod]);
  await deployProfile(h.config, 'gta5', h.gamePath, vanilla, [mod]);
  await deployProfile(h.config, 'gta5', h.gamePath, p, [mod]);

  for (const [rel, content] of Object.entries(CHAOS)) {
    assert.ok(await present(path.join(h.gamePath, rel)), `${rel} should be back`);
    assert.equal(await read(path.join(h.gamePath, rel)), content, `${rel} intact`);
  }
});
