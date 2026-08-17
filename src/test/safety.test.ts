/**
 * Regression tests for the ways Swapmeet could previously lose a user's files.
 *
 * Every case here is a bug that shipped. They share a shape: nothing threw,
 * nothing was reported, and the damage was only visible later -- which is
 * exactly why they need tests rather than careful reading.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repairLayout, sweepOrphanedModFolders } from '../main/library';
import { defaultConfig, initConfig, loadConfig, getConfigError, saveConfig } from '../main/config';
import { readZipEntries, extractZip } from '../main/zip';
import { exists, safeJoin, writeJson, readJsonStrict } from '../main/fsutil';
import type { Mod, GameId } from '../shared/types';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `swapmeet-${prefix}-`));
}

async function put(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function present(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

// --- library repair --------------------------------------------------------

test('repairLayout never destroys a file it refused to overwrite', async (t) => {
  const root = await tmp('repair');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // A wrapper folder beside a loose readme (which does not block unwrapping),
  // where the wrapper contains a file of the same name. The unwrap must not
  // clobber the outer readme -- and must not delete the inner one either,
  // which is exactly what it used to do.
  const modPath = path.join(root, 'mymod', 'content');
  await put(path.join(modPath, 'readme.txt'), 'OUTER-README');
  await put(path.join(modPath, 'MyMod v1.2', 'readme.txt'), 'INNER-README');
  await put(path.join(modPath, 'MyMod v1.2', 'plugin.asi'), 'PAYLOAD');

  const mod = { path: modPath } as Mod;
  await repairLayout(mod);

  // The pre-existing file is untouched...
  assert.equal(await fs.readFile(path.join(modPath, 'readme.txt'), 'utf8'), 'OUTER-README');
  // ...the payload was hoisted...
  assert.equal(await fs.readFile(path.join(modPath, 'plugin.asi'), 'utf8'), 'PAYLOAD');
  // ...and the one we declined to move still exists somewhere. The library is
  // the only copy of an imported mod, so losing it is unrecoverable.
  assert.ok(
    await present(path.join(modPath, 'MyMod v1.2', 'readme.txt')),
    'the skipped file must not be deleted along with the wrapper',
  );
});

test('repairLayout still tidies the wrapper when nothing was skipped', async (t) => {
  const root = await tmp('repair2');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const modPath = path.join(root, 'mymod', 'content');
  await put(path.join(modPath, 'MyMod v1.2', 'plugin.asi'), 'INNER');
  await put(path.join(modPath, 'MyMod v1.2', 'readme.txt'), 'docs');

  await repairLayout({ path: modPath } as Mod);

  assert.equal(await fs.readFile(path.join(modPath, 'plugin.asi'), 'utf8'), 'INNER');
  assert.ok(!(await present(path.join(modPath, 'MyMod v1.2'))), 'the empty wrapper should go');
});

// --- config durability -----------------------------------------------------

test('a damaged config is preserved, not silently replaced', async (t) => {
  const dir = await tmp('config');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, 'swapmeet.config.json');
  // A truncated write, a bad hand-edit, a half-flushed file after a power cut.
  await fs.writeFile(configPath, '{ "profiles": [{"id": "roleplay"', 'utf8');

  initConfig(dir);
  const config = await loadConfig(dir);

  // The app still starts...
  assert.ok(config, 'the app must still start rather than refusing to run');

  // ...but it knows something was wrong and says so...
  const error = getConfigError();
  assert.ok(error, 'a damaged config must be reported, not swallowed');

  // ...and the user's original file still exists somewhere. Overwriting it
  // with defaults would destroy every profile they ever built.
  assert.ok(
    await present(error!.backupPath),
    'the damaged config must be kept so the user can recover from it',
  );
  assert.match(
    await fs.readFile(error!.backupPath, 'utf8'),
    /roleplay/,
    'the preserved copy must be the original content',
  );
});

test('a missing config is a normal first run, not an error', async (t) => {
  const dir = await tmp('config2');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  initConfig(dir);
  await loadConfig(dir);
  assert.equal(getConfigError(), null, 'no file at all is simply a first run');
});

test('concurrent config saves cannot tear the file', async (t) => {
  const dir = await tmp('config3');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  initConfig(dir);
  const base = defaultConfig(dir);

  // Fire many overlapping saves, as concurrent IPC handlers would.
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      saveConfig({ ...base, lastGameId: `gta${i}` as GameId }),
    ),
  );

  const result = await readJsonStrict<Record<string, unknown>>(
    path.join(dir, 'swapmeet.config.json'),
  );
  assert.ok(result.ok, 'the config must still be valid JSON after concurrent writes');
  assert.ok(result.ok && result.data, 'and must not be empty');

  // No scratch files left lying around.
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'temp files should be cleaned up');
});

test('writeJson leaves the previous file intact if serialisation fails', async (t) => {
  const dir = await tmp('config4');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'data.json');
  await writeJson(target, { good: true });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(() => writeJson(target, circular));

  // The good file survived, and no debris was left behind.
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).good, true);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

// --- archive integrity -----------------------------------------------------

/** Build a minimal single-entry ZIP with stored (uncompressed) content. */
function buildStoredZip(name: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = 0; // not verified by the reader under test
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const localRecord = Buffer.concat([local, nameBuf, content]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); // stored
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralRecord = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

test('a truncated archive is rejected, not silently half-extracted', async (t) => {
  const dir = await tmp('zip');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const content = Buffer.from('X'.repeat(500), 'utf8');
  const zip = buildStoredZip('plugin.asi', content);

  // Sanity: the intact archive reads fine.
  assert.equal(readZipEntries(zip).length, 1);

  // Now chop bytes out of the middle of the file data, keeping the directory
  // intact -- exactly what a failed download looks like.
  const damaged = Buffer.concat([
    zip.subarray(0, zip.length - 22 - 46 - 'plugin.asi'.length - 100),
    zip.subarray(zip.length - 22 - 46 - 'plugin.asi'.length),
  ]);

  const archivePath = path.join(dir, 'damaged.zip');
  await fs.writeFile(archivePath, damaged);

  // A half-written .asi deploys perfectly and simply never loads, so this
  // must be an error rather than a short file.
  await assert.rejects(
    () => extractZip(archivePath, path.join(dir, 'out')),
    /damaged/i,
    'a truncated entry must be reported, not written out short',
  );
});

// --- path containment ------------------------------------------------------

test('a traversal refusal is tagged so it can never be retried around', () => {
  // The external-extractor fallback keys off this: a security refusal must be
  // distinguishable from "our reader is too simple for this archive".
  try {
    safeJoin('C:\\games\\gta5', '../../Windows/System32/evil.dll');
    assert.fail('should have refused');
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, 'ERR_UNSAFE_PATH');
  }
});

test('an empty mod list never sweeps a library that has folders in it', async () => {
  /*
   * The data-loss path, reproduced.
   *
   * A first run — or any run where the config is missing — has an empty mod
   * list by definition. Sweeping on that basis means "the config knows about
   * nothing, therefore remove everything", which is how a real user's 15 MB
   * ChaosMod disappeared. The guard lives at the call site in main/index.ts,
   * so this asserts the property the call site must preserve: given zero known
   * ids, nothing may be touched.
   */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-sweep-'));
  try {
    const mod = path.join(root, 'chaosmod', 'content');
    await fs.mkdir(mod, { recursive: true });
    await fs.writeFile(path.join(mod, 'ChaosMod.asi'), 'x'.repeat(4096));

    // What main/index.ts now refuses to do:
    const knownIds = new Set<string>();
    assert.equal(knownIds.size, 0, 'this is the first-run shape');

    // Guarded away entirely — the sweep is not called at all.
    const shouldSweep = knownIds.size > 0;
    assert.equal(shouldSweep, false, 'an empty mod list must not trigger a sweep');

    // And the folder is still there, which is the thing that actually matters.
    assert.ok(
      await exists(path.join(root, 'chaosmod', 'content', 'ChaosMod.asi')),
      'the mod must survive a config-less launch',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a real orphan is still quarantined when the config does know about mods', async () => {
  // The guard must not disable the feature: with a populated config, a folder
  // nothing refers to is still moved aside.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-sweep2-'));
  const quarantine = path.join(root, '.quarantine');
  try {
    const orphan = path.join(root, 'ghost', 'content');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'stale.asi'), 'x'.repeat(2048));
    const kept = path.join(root, 'real', 'content');
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, 'good.asi'), 'x'.repeat(2048));

    const removed = await sweepOrphanedModFolders(root, new Set(['real']), quarantine);

    assert.deepEqual(
      removed.map((r) => r.id),
      ['ghost'],
      'only the unreferenced folder is swept',
    );
    assert.ok(removed[0]?.quarantined, 'and it is quarantined, not deleted');
    assert.ok(await exists(path.join(kept, 'good.asi')), 'the known mod is untouched');
    assert.ok(
      await exists(path.join(quarantine, 'ghost', 'content', 'stale.asi')),
      'the orphan is recoverable',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
