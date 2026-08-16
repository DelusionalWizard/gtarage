/**
 * Tests for add-on DLC pack detection.
 *
 * The paths here are real add-on layouts. Mod authors ship both
 * `dlcpacks/name` and `mods/update/x64/dlcpacks/name` depending on whether the
 * archive was built for a mods folder, and they are inconsistent about casing,
 * so both had to be handled before this was worth shipping.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countPacks,
  dlcGaps,
  dlcListEntry,
  dlcListLine,
  dlcPacksIn,
  listedPacks,
  needsGameconfig,
} from '../shared/dlcpacks';

test('the dlclist entry keeps the scheme and the trailing slash', () => {
  // Both are load-bearing: the game matches this string literally, so a
  // missing slash is a pack that never loads and says nothing about why.
  assert.equal(dlcListEntry('addonpeds'), 'dlcpacks:/addonpeds/');
  assert.equal(dlcListLine('addonpeds'), '<Item>dlcpacks:/addonpeds/</Item>');
});

test('a pack is found under the plain update path', () => {
  assert.deepEqual(
    dlcPacksIn(['update/x64/dlcpacks/patchday27ng/dlc.rpf']),
    ['patchday27ng'],
  );
});

test('a pack is found under a mods-folder path', () => {
  assert.deepEqual(
    dlcPacksIn(['mods/update/x64/dlcpacks/addonpeds/dlc.rpf']),
    ['addonpeds'],
  );
});

test('every file of one pack collapses to a single pack name', () => {
  const packs = dlcPacksIn([
    'mods/update/x64/dlcpacks/vanillaworks/dlc.rpf',
    'mods/update/x64/dlcpacks/vanillaworks/content.xml',
    'mods/update/x64/dlcpacks/vanillaworks/data/handling.meta',
  ]);
  assert.deepEqual(packs, ['vanillaworks']);
});

test('several packs in one mod are all found', () => {
  const packs = dlcPacksIn([
    'mods/update/x64/dlcpacks/carpack1/dlc.rpf',
    'mods/update/x64/dlcpacks/carpack2/dlc.rpf',
  ]);
  assert.deepEqual(packs.sort(), ['carpack1', 'carpack2']);
});

test('a mod that installs no packs reports none', () => {
  assert.deepEqual(dlcPacksIn(['scripts/Trainer.dll', 'Trainer.asi']), []);
});

test('backslashes are handled, because archives contain them', () => {
  assert.deepEqual(
    dlcPacksIn(['mods\\update\\x64\\dlcpacks\\addonpeds\\dlc.rpf']),
    ['addonpeds'],
  );
});

test('listed packs are read out of a dlclist', () => {
  const xml = `<SMandatoryPacksData><Paths>
    <Item>dlcpacks:/patchday1ng/</Item>
    <Item>dlcpacks:/addonpeds/</Item>
  </Paths></SMandatoryPacksData>`;
  assert.deepEqual(listedPacks(xml).sort(), ['addonpeds', 'patchday1ng']);
});

test('casing does not decide whether a pack counts as listed', () => {
  // Authors write AddonPeds, addonpeds and ADDONPEDS interchangeably, and the
  // game does not care. Comparing raw would report a missing entry for a pack
  // that is in fact listed, which is the worst possible failure here.
  const xml = '<Item>dlcpacks:/AddonPeds/</Item>';
  const gaps = dlcGaps(['mods/update/x64/dlcpacks/addonpeds/dlc.rpf'], xml);
  assert.deepEqual(gaps, []);
});

test('an unlisted pack is reported with the line to paste', () => {
  const xml = '<Item>dlcpacks:/patchday1ng/</Item>';
  const gaps = dlcGaps(['mods/update/x64/dlcpacks/vanillaworks/dlc.rpf'], xml);
  assert.deepEqual(gaps, [
    { pack: 'vanillaworks', line: '<Item>dlcpacks:/vanillaworks/</Item>' },
  ]);
});

test('an unreadable dlclist reports every pack as unconfirmed', () => {
  // dlclist.xml lives inside update.rpf and there is no RPF reader, so this is
  // the normal case, not an edge case.
  const gaps = dlcGaps(['mods/update/x64/dlcpacks/addonpeds/dlc.rpf'], null);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.pack, 'addonpeds');
});

test('a mod installing no packs has no gaps even with no dlclist', () => {
  assert.deepEqual(dlcGaps(['scripts/Trainer.dll'], null), []);
});

test('packs are counted across mods without double counting', () => {
  const count = countPacks([
    ['mods/update/x64/dlcpacks/a/dlc.rpf', 'mods/update/x64/dlcpacks/b/dlc.rpf'],
    ['mods/update/x64/dlcpacks/b/dlc.rpf'],
    ['scripts/x.dll'],
  ]);
  assert.equal(count, 2);
});

test('a handful of add-ons does not demand a gameconfig', () => {
  // Crying wolf here trains people to ignore the warning by the time it is
  // real. The stock pools genuinely cope with a few add-ons.
  assert.ok(!needsGameconfig(0));
  assert.ok(!needsGameconfig(1));
  assert.ok(!needsGameconfig(7));
});

test('a large add-on collection does', () => {
  assert.ok(needsGameconfig(8));
  assert.ok(needsGameconfig(30));
});
