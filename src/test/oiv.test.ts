/**
 * Tests for reading OpenIV packages.
 *
 * The shape here follows real `.oiv` assemblies: metadata, then a content
 * block mixing plain file placement with edits inside RPF archives. The
 * distinction between those two is the entire point — treating an archive
 * edit as a file copy is what made GTArage install a package that changed
 * nothing in the game.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeOiv,
  oivVerdict,
  parseOiv,
  parseOivMetadata,
  parseOivOperations,
} from '../shared/oiv';

const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.1" id="{a}" target="Grand Theft Auto V">
  <metadata>
    <name>Example Vehicle Pack</name>
    <version><major>1</major><minor>2</minor></version>
    <author><displayName>Somebody</displayName></author>
    <description>Adds a car.</description>
  </metadata>
  <content>
    <add source="files/mycar.meta">mods\\update\\update.rpf\\common\\data\\mycar.meta</add>
    <archive path="mods\\x64e.rpf" createIfNotExist="False" type="RPF7">
      <add source="files/mycar.ytd">levels\\gta5\\vehicles.rpf\\mycar.ytd</add>
      <add source="files/mycar.yft">levels\\gta5\\vehicles.rpf\\mycar.yft</add>
    </archive>
    <add source="files/readme.txt">readme.txt</add>
  </content>
</package>`;

const ARCHIVE_ONLY = `<?xml version="1.0"?>
<package version="2.1">
  <metadata><name>Texture Overhaul</name></metadata>
  <content>
    <archive path="mods\\x64a.rpf" type="RPF7">
      <add source="a.ytd">a.ytd</add>
    </archive>
    <archive path="mods\\x64b.rpf" type="RPF7">
      <add source="b.ytd">b.ytd</add>
    </archive>
  </content>
</package>`;

const COPY_ONLY = `<?xml version="1.0"?>
<package version="2.1">
  <metadata><name>Simple Script</name></metadata>
  <content>
    <add source="files/script.asi">script.asi</add>
  </content>
</package>`;

test('metadata is read out of the package', () => {
  const meta = parseOivMetadata(MIXED);
  assert.equal(meta.name, 'Example Vehicle Pack');
  assert.equal(meta.author, 'Somebody');
  assert.equal(meta.description, 'Adds a car.');
});

test('a file placed outside an archive is a copy', () => {
  const ops = parseOivOperations(COPY_ONLY);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.kind, 'copy');
  assert.equal(ops[0]?.source, 'files/script.asi');
  assert.equal(ops[0]?.target, 'script.asi');
});

test('files nested inside an archive are NOT counted as copies', () => {
  // The regression this module exists for. Two <add> elements sit inside the
  // archive block; counting them as placeable files is what produced a mod
  // that deployed cleanly and did nothing.
  const ops = parseOivOperations(MIXED);
  const copies = ops.filter((o) => o.kind === 'copy');
  assert.deepEqual(
    copies.map((c) => c.source),
    ['files/mycar.meta', 'files/readme.txt'],
  );
});

test('each archive the package edits is reported', () => {
  const ops = parseOivOperations(ARCHIVE_ONLY);
  const archives = ops.filter((o) => o.kind === 'archive').map((o) => o.target);
  assert.deepEqual(archives, ['mods\\x64a.rpf', 'mods\\x64b.rpf']);
});

test('a package that only edits archives is a hand-off', () => {
  const verdict = oivVerdict(parseOiv(ARCHIVE_ONLY));
  assert.equal(verdict.handOff, true);
  assert.equal(verdict.copies.length, 0);
  assert.equal(verdict.archives.length, 2);
  assert.match(describeOiv(verdict), /OpenIV/);
});

test('a package that only copies files needs no hand-off', () => {
  const verdict = oivVerdict(parseOiv(COPY_ONLY));
  assert.equal(verdict.handOff, false);
  assert.equal(verdict.needsOpenIv.length, 0);
  assert.match(describeOiv(verdict), /like any other mod/);
});

test('a mixed package is reported as partly installable', () => {
  // The dangerous middle case: installing it half works, and saying nothing
  // leaves the user to discover which half.
  const verdict = oivVerdict(parseOiv(MIXED));
  assert.equal(verdict.handOff, false);
  assert.equal(verdict.copies.length, 2);
  assert.ok(verdict.needsOpenIv.length > 0);
  assert.match(describeOiv(verdict), /only partly installed/);
});

test('a self-closing archive element still counts', () => {
  const ops = parseOivOperations('<content><archive path="mods\\x64a.rpf" /></content>');
  assert.equal(ops.filter((o) => o.kind === 'archive').length, 1);
});

test('malformed XML still yields an answer rather than throwing', () => {
  // Authors hand-edit these. Refusing to describe a package because of a
  // stray ampersand would be worse than useless.
  const ops = parseOivOperations('<content><add source="a & b.ytd">x.ytd</add>');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.source, 'a & b.ytd');
});

test('an empty assembly describes itself as doing nothing actionable', () => {
  const verdict = oivVerdict(parseOiv('<package><content></content></package>'));
  assert.equal(verdict.handOff, false);
  assert.match(describeOiv(verdict), /does not appear to change anything/);
});
