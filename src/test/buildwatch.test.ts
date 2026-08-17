/**
 * Tests for game build tracking.
 *
 * Every version string here is a real one - the two GTA V builds detected on
 * the development machine, and Script Hook V archive names as the project
 * actually publishes them. Invented examples would not have caught that Script
 * Hook V names two builds in one filename, which is the whole reason a single
 * download serves both Legacy and Enhanced.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOf,
  changedBuilds,
  hookBuilds,
  hookVerdict,
  isBuildSensitive,
  recordBuilds,
} from '../shared/buildwatch';

test('the comparable build drops the fixed leading 1.0', () => {
  // Both of these were read off real installs by detect.ts.
  assert.equal(buildOf('1.0.3889.0'), '3889.0');
  assert.equal(buildOf('1.0.1158.13'), '1158.13');
});

test('a version that is not a version yields nothing', () => {
  assert.equal(buildOf(undefined), null);
  assert.equal(buildOf(''), null);
  assert.equal(buildOf('1.0'), null);
  assert.equal(buildOf('unknown'), null);
});

test('one ScriptHookV archive names both game builds', () => {
  // The real filename from the user's Downloads folder. This is exactly why
  // splitting ScriptHookV into a Legacy build and an Enhanced build was wrong.
  const builds = hookBuilds('ScriptHookV_3889.0_1158.13.zip');
  assert.deepEqual(builds, ['3889.0', '1158.13']);
});

test('a ScriptHookV copy matches the game it targets', () => {
  const name = 'ScriptHookV_3889.0_1158.13.zip';
  assert.equal(hookVerdict(name, '1.0.3889.0').state, 'match');
  assert.equal(hookVerdict(name, '1.0.1158.13').state, 'match');
});

test('a ScriptHookV copy left behind by an older patch is a mismatch', () => {
  // The situation this feature exists for: game patched, hook did not.
  const verdict = hookVerdict('ScriptHookV_3521.0_1084.6.zip', '1.0.3889.0');
  assert.equal(verdict.state, 'mismatch');
  assert.deepEqual(verdict.builds, ['3521.0', '1084.6']);
});

test('a copy with no version in its name is unknown, not a mismatch', () => {
  // Adopted out of a game folder, this is all we ever have. Claiming a
  // mismatch here would cry wolf on a perfectly working install.
  assert.equal(hookVerdict('ScriptHookV.dll', '1.0.3889.0').state, 'unknown');
  assert.equal(hookVerdict('scripthookv.zip', '1.0.3889.0').state, 'unknown');
});

test('an unreadable game version is unknown, not a mismatch', () => {
  assert.equal(hookVerdict('ScriptHookV_3889.0_1158.13.zip', undefined).state, 'unknown');
});

test('a first sighting is not an update', () => {
  // Pointing GTArage at an install for the first time must not announce that
  // the game just updated.
  const changes = changedBuilds({}, [{ gameId: 'gta5', version: '1.0.3889.0' }]);
  assert.deepEqual(changes, []);
});

test('the same build twice is not an update', () => {
  const seen = { gta5: '1.0.3889.0' };
  assert.deepEqual(changedBuilds(seen, [{ gameId: 'gta5', version: '1.0.3889.0' }]), []);
});

test('a moved build is reported with both sides', () => {
  const seen = { gta5: '1.0.3521.0' };
  const changes = changedBuilds(seen, [{ gameId: 'gta5', version: '1.0.3889.0' }]);
  assert.deepEqual(changes, [
    { gameId: 'gta5', previous: '1.0.3521.0', current: '1.0.3889.0' },
  ]);
});

test('a game whose version cannot be read is skipped, not reported', () => {
  const seen = { gta5: '1.0.3521.0' };
  assert.deepEqual(changedBuilds(seen, [{ gameId: 'gta5', version: undefined }]), []);
});

test('each game is tracked separately', () => {
  // Legacy and Enhanced update independently and share nothing.
  const seen = { gta5: '1.0.3521.0', gta5e: '1.0.1158.13' };
  const changes = changedBuilds(seen, [
    { gameId: 'gta5' as const, version: '1.0.3889.0' },
    { gameId: 'gta5e' as const, version: '1.0.1158.13' },
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.gameId, 'gta5');
});

test('recording builds leaves other games alone', () => {
  const seen = { gta5: '1.0.3521.0', gtasa: '1.0' };
  const next = recordBuilds(seen, [{ gameId: 'gta5' as const, version: '1.0.3889.0' }]);
  assert.equal(next.gta5, '1.0.3889.0');
  assert.equal(next.gtasa, '1.0', 'an untouched game keeps its recorded build');
  assert.equal(seen.gta5, '1.0.3521.0', 'the original is not mutated');
});

test('only script-bearing mods are build sensitive', () => {
  assert.ok(isBuildSensitive({ kind: 'asi' }));
  assert.ok(isBuildSensitive({ kind: 'script' }));
  // A texture pack does not care which build is loading it. Listing it would
  // send people uninstalling things that are working fine.
  assert.ok(!isBuildSensitive({ kind: 'replace' }));
  assert.ok(!isBuildSensitive({ kind: 'graphics' }));
  assert.ok(!isBuildSensitive({ kind: 'oiv' }));
});

test('a mod that depends on ScriptHookV is build sensitive whatever its kind', () => {
  assert.ok(
    isBuildSensitive({ kind: 'replace', dependencies: [{ capability: 'scripthookv' }] }),
  );
});
