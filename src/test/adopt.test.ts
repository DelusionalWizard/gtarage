/**
 * Tests for adopting hand-installed mods.
 *
 * Every name here is a real distribution. The exact-match rule this replaced
 * looked correct and quietly failed on most of them, which is why the same
 * complaint — "the mod's folder does not come with it" — kept coming back
 * after being reported fixed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isCompanionFolder } from '../main/adopt';

test('a folder named exactly after the plugin is claimed', () => {
  assert.ok(isCompanionFolder('NativeTrainer', 'NativeTrainer'));
  assert.ok(isCompanionFolder('ChaosMod', 'chaosmod'), 'casing must not matter');
});

test('a versioned plugin claims its unversioned folder', () => {
  // ChaosModV ships ChaosModV.asi beside a plain `chaosmod` folder. Exact
  // matching missed this, which is the case that was actually reported.
  assert.ok(isCompanionFolder('ChaosModV', 'chaosmod'));
});

test('a plugin claims a folder with a suffix', () => {
  // Menyoo is the common one: Menyoo.asi plus menyooStuff/.
  assert.ok(isCompanionFolder('Menyoo', 'menyooStuff'));
});

test('unrelated folders are never claimed', () => {
  for (const folder of ['update', 'x64', 'BattlEye', 'Redistributables', 'scripts']) {
    assert.ok(
      !isCompanionFolder('ChaosModV', folder),
      `${folder} must not be claimed by ChaosModV`,
    );
  }
});

test('two different plugins do not claim each other', () => {
  assert.ok(!isCompanionFolder('Menyoo', 'chaosmod'));
  assert.ok(!isCompanionFolder('ChaosModV', 'menyooStuff'));
});

test('short stems fall back to exact matching', () => {
  // Without a length floor, a stem this short prefix-matches half a game
  // folder — "x64" would claim itself and anything starting with it.
  assert.ok(!isCompanionFolder('sh', 'shaders'));
  assert.ok(!isCompanionFolder('x64', 'x64a'));
  assert.ok(isCompanionFolder('x64', 'x64'));
});
