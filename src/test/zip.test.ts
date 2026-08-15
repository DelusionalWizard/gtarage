/**
 * Round-trip tests for the built-in ZIP reader.
 *
 * Archives are how mods actually arrive, so a reader that quietly mangles one
 * is the worst kind of bug: the mod appears to install and then does nothing.
 * These build real archives byte by byte and read them back.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, crc32 } from 'node:zlib';

import { extractZip, readZipEntries } from '../main/zip';
import { safeFileName } from '../main/net';

/** Build a ZIP in memory. `stored` forces compression method 0. */
function makeZip(files: Array<{ name: string; data: string }>, stored = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(file.data, 'utf8');
    const compressed = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(stored ? 0 : 8, 8); // method
    local.writeUInt32LE(0, 10); // time+date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);

    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'swapmeet-zip-'));
}

test('reads the central directory of a deflated archive', () => {
  const zip = makeZip([
    { name: 'readme.txt', data: 'requires ScriptHookV' },
    { name: 'scripts/mod.dll', data: 'binary-ish' },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['readme.txt', 'scripts/mod.dll'],
  );
  assert.equal(entries[0]?.compressionMethod, 8);
});

test('extracts deflated content correctly', async () => {
  const dir = await tmpDir();
  const archive = path.join(dir, 'mod.zip');
  await fs.writeFile(archive, makeZip([{ name: 'a/b/hello.txt', data: 'hello mod world' }]));

  const dest = path.join(dir, 'out');
  const written = await extractZip(archive, dest);

  assert.deepEqual(written, ['a/b/hello.txt']);
  assert.equal(await fs.readFile(path.join(dest, 'a/b/hello.txt'), 'utf8'), 'hello mod world');
  await fs.rm(dir, { recursive: true, force: true });
});

test('extracts stored (uncompressed) entries too', async () => {
  const dir = await tmpDir();
  const archive = path.join(dir, 'stored.zip');
  await fs.writeFile(archive, makeZip([{ name: 'plugin.asi', data: 'MZ-not-really' }], true));

  const dest = path.join(dir, 'out');
  await extractZip(archive, dest);
  assert.equal(await fs.readFile(path.join(dest, 'plugin.asi'), 'utf8'), 'MZ-not-really');
  await fs.rm(dir, { recursive: true, force: true });
});

test('backslash paths from Windows-built archives are normalised', () => {
  const entries = readZipEntries(makeZip([{ name: 'scripts\\sub\\mod.dll', data: 'x' }]));
  assert.equal(entries[0]?.name, 'scripts/sub/mod.dll');
});

test('a traversal entry is refused rather than written outside the destination', async () => {
  const dir = await tmpDir();
  const archive = path.join(dir, 'evil.zip');
  await fs.writeFile(archive, makeZip([{ name: '../../escaped.txt', data: 'nope' }]));

  await assert.rejects(
    () => extractZip(archive, path.join(dir, 'out')),
    /Refusing to write outside/,
  );
  // And nothing landed where it tried to go.
  await assert.rejects(() => fs.access(path.join(dir, 'escaped.txt')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('a non-archive is rejected with a clear message', () => {
  assert.throws(() => readZipEntries(Buffer.from('this is not a zip at all')), /Not a ZIP archive/);
});

test('safeFileName strips path separators and traversal', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('My Mod v1.2.zip'), 'My Mod v1.2.zip');
  assert.equal(safeFileName('bad:name?.zip'), 'bad_name_.zip');
  assert.equal(safeFileName(''), 'download');
});
