/**
 * Regression tests for catalog asset selection.
 *
 * These exist because the first working version of the browser offered San
 * Andreas a *Splinter Cell* widescreen fix (the Widescreen Fixes Pack repo
 * covers a hundred games and its "latest release" is whichever was patched
 * last) and a 64-bit ASI loader for a 32-bit game (which would simply never
 * load). Both are silent failures, so they get pinned down here.
 *
 * The asset lists below are the real ones, copied from the GitHub API.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { dependencyFixesFor } from '../main/depscan';
import { selectAssets } from '../main/providers/github';
import { ESSENTIALS, essentialsFor } from '../shared/catalog';
import type { GameId } from '../shared/types';

function def(id: string) {
  const found = ESSENTIALS.find((e) => e.id === id);
  assert.ok(found, `no catalog entry ${id}`);
  return found;
}

const asset = (name: string) => ({ name });

test('the ASI loader matches the game architecture', () => {
  const assets = [asset('Ultimate-ASI-Loader.zip'), asset('Ultimate-ASI-Loader_x64.zip')];
  const ual = def('ultimate-asi-loader');

  // Every game UAL still covers is a 32-bit process; the x64 build would
  // never load in one.
  for (const gameId of ['gta3', 'gtavc', 'gtasa', 'gta4'] as GameId[]) {
    assert.equal(
      selectAssets(ual, gameId, assets)[0]?.name,
      'Ultimate-ASI-Loader.zip',
      `${gameId} should get the 32-bit loader`,
    );
  }
});

test('Ultimate ASI Loader is not offered where ScriptHookV already provides one', () => {
  // The ScriptHookV download bundles its own dinput8.dll. Offering UAL as
  // well is redundant and makes both mods claim the same file.
  const ual = def('ultimate-asi-loader');
  // Legacy and Enhanced each carry their own ScriptHookV build, and both
  // bundle the loader — so neither should be offered UAL.
  const hookFor: Record<string, string> = {
    gta5: 'scripthookv',
    gta5e: 'scripthookv-enhanced',
  };
  for (const gameId of ['gta5', 'gta5e'] as GameId[]) {
    assert.ok(!ual.games.includes(gameId), `UAL must not be listed for ${gameId}`);
    assert.ok(
      !essentialsFor(gameId).some((e) => e.id === 'ultimate-asi-loader'),
      `${gameId} must not see UAL in its catalogue`,
    );
    assert.ok(
      essentialsFor(gameId).some((e) => e.id === hookFor[gameId]),
      `${gameId} still needs ${hookFor[gameId]}, which carries the loader`,
    );
  }
});

test('the Definitive Editions use UE4SS rather than an ASI loader', () => {
  for (const gameId of ['gta3de', 'gtavcde', 'gtasade'] as GameId[]) {
    const ids = essentialsFor(gameId).map((e) => e.id);
    assert.ok(!ids.includes('ultimate-asi-loader'));
    assert.ok(ids.includes('ue4ss'), `${gameId} should be offered UE4SS`);
  }
});

test('Enhanced gets its own tooling, not Legacy tooling', () => {
  // Enhanced is a separate executable with BattlEye; the Legacy script hook
  // does not load in it, so offering Legacy's entries there is wrong.
  const legacy = essentialsFor('gta5' as GameId).map((e) => e.id);
  const enhanced = essentialsFor('gta5e' as GameId).map((e) => e.id);

  assert.ok(legacy.includes('scripthookv'), 'Legacy keeps the Legacy hook');
  assert.ok(legacy.includes('scripthookvdotnet'), 'Legacy keeps stable SHVDN');

  assert.ok(!enhanced.includes('scripthookv'), 'Enhanced must not offer the Legacy hook');
  assert.ok(
    !enhanced.includes('scripthookvdotnet'),
    'Enhanced must not offer the stable SHVDN build, which predates it',
  );
  assert.ok(enhanced.includes('scripthookv-enhanced'));
  assert.ok(enhanced.includes('scripthookvdotnet-nightly'));
});

test('Enhanced dependency fixes resolve to Enhanced builds', () => {
  const fixes = dependencyFixesFor('gta5e' as GameId);
  assert.ok(fixes.includes('scripthookv-enhanced'));
  assert.ok(fixes.includes('scripthookvdotnet-nightly'));
  assert.ok(!fixes.includes('scripthookv'), 'must not send Enhanced to the Legacy hook');
  assert.ok(!fixes.includes('scripthookvdotnet'));
});

test('the classic games still get an ASI loader', () => {
  for (const gameId of ['gta3', 'gtavc', 'gtasa', 'gta4'] as GameId[]) {
    assert.ok(
      essentialsFor(gameId).some((e) => e.id === 'ultimate-asi-loader'),
      `${gameId} ships without a loader and still needs UAL`,
    );
  }
});

test('every offered fix names a catalogue entry that game can actually get', () => {
  // Guards the failure mode this change could have introduced: a detected
  // dependency pointing at an entry the game's catalogue no longer lists,
  // leaving an "Install" button that cannot work.
  const games: GameId[] = [
    'gta5',
    'gta5e',
    'gta4',
    'gtasa',
    'gtavc',
    'gta3',
    'gta3de',
    'gtavcde',
    'gtasade',
  ];
  for (const gameId of games) {
    const available = new Set(essentialsFor(gameId).map((e) => e.id));
    for (const dep of dependencyFixesFor(gameId)) {
      assert.ok(
        available.has(dep),
        `${gameId} offers "${dep}" as a fix but cannot install it`,
      );
    }
  }
});

test('CLEO Redux matches the architecture and never picks the installer', () => {
  const assets = [
    asset('cleo_redux_1.5.0.x64.zip'),
    asset('cleo_redux_1.5.0.x86.zip'),
    asset('cleo_redux_setup.exe'),
  ];
  const cleo = def('cleo-redux');

  assert.equal(selectAssets(cleo, 'gtasa' as GameId, assets)[0]?.name, 'cleo_redux_1.5.0.x86.zip');
  assert.equal(selectAssets(cleo, 'gta5' as GameId, assets)[0]?.name, 'cleo_redux_1.5.0.x64.zip');
});

test('SilentPatch picks the build for the right game', () => {
  // One release ships every game's build side by side.
  const assets = [
    asset('SilentPatchDDraw.zip'),
    asset('SilentPatchIII.zip'),
    asset('SilentPatchSA.zip'),
    asset('SilentPatchVC.zip'),
  ];
  const sp = def('silentpatch');

  assert.equal(selectAssets(sp, 'gtasa' as GameId, assets)[0]?.name, 'SilentPatchSA.zip');
  assert.equal(selectAssets(sp, 'gtavc' as GameId, assets)[0]?.name, 'SilentPatchVC.zip');
  assert.equal(selectAssets(sp, 'gta3' as GameId, assets)[0]?.name, 'SilentPatchIII.zip');
});

test('Widescreen Fixes Pack is pinned to a per-game release tag', () => {
  const wfp = def('widescreen-fixes');
  // Without these, `latest` resolves to an unrelated game's fix.
  assert.equal(wfp.releaseTags?.gtasa, 'gtasa');
  assert.equal(wfp.releaseTags?.gtavc, 'gtavc');
  assert.equal(wfp.releaseTags?.gta3, 'gta3');
  // Every game it claims to support must have a tag, or it would fall back
  // to `latest` and serve a different game entirely.
  for (const gameId of wfp.games) {
    assert.ok(wfp.releaseTags?.[gameId], `${gameId} needs a release tag`);
  }
});

test('Widescreen Fixes Pack prefers the main fix over the frontend extra', () => {
  const assets = [asset('GTASA.WidescreenFrontend.zip'), asset('GTASA.WidescreenFix.zip')];
  assert.equal(
    selectAssets(def('widescreen-fixes'), 'gtasa' as GameId, assets)[0]?.name,
    'GTASA.WidescreenFix.zip',
  );
});

test('an unrecognised release layout falls back rather than showing nothing', () => {
  // Upstream renamed everything; we must still offer something.
  const assets = [asset('completely-different-name.zip')];
  const picked = selectAssets(def('silentpatch'), 'gtasa' as GameId, assets);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.name, 'completely-different-name.zip');
});

test('archives outrank installers and debug builds by default', () => {
  const assets = [
    asset('zDEV-UE4SS_v3.0.1.zip'),
    asset('UE4SS_v3.0.1.zip'),
    asset('installer.exe'),
  ];
  assert.equal(selectAssets({}, 'gtasade' as GameId, assets)[0]?.name, 'UE4SS_v3.0.1.zip');
});

test('every catalog entry either has a repo or explains why not', () => {
  for (const entry of ESSENTIALS) {
    if (!entry.repo) {
      assert.ok(entry.manualReason, `${entry.id} has no repo and no explanation`);
    }
    assert.ok(entry.games.length > 0, `${entry.id} applies to no games`);
    assert.ok(/^https?:\/\//.test(entry.homepage), `${entry.id} has no usable homepage`);
  }
});

test('every supported game offers at least one essential', () => {
  for (const gameId of ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3', 'gtasade'] as GameId[]) {
    assert.ok(essentialsFor(gameId).length > 0, `${gameId} has no essentials`);
  }
});
