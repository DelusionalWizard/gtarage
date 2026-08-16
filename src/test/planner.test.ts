/**
 * Tests for the rules users get burned by: who wins a contested file, what a
 * swap will actually do, and whether the vanilla lock really deploys nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeMods,
  buildSwapPlan,
  findConflicts,
  isInertFile,
  formatBytes,
  misorderedCoreMods,
  missingDependencies,
  normaliseOrder,
  reorder,
  resolveFileMap,
  targetPath,
} from '../shared/planner';
import type { GameId, Mod, Profile } from '../shared/types';

function mod(id: string, over: Partial<Mod> = {}): Mod {
  return {
    id,
    gameId: 'gta5' as GameId,
    name: id,
    kind: 'replace',
    version: '1.0',
    path: `/library/${id}`,
    files: ['common/data/handling.meta'],
    size: 1024,
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'vehicles',
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

test('deploy root is applied per mod kind', () => {
  // A `replace` mod on GTA V belongs under mods/, an `asi` at the game root.
  assert.equal(
    targetPath(mod('a', { kind: 'replace' }), 'common/data/handling.meta'),
    'mods/common/data/handling.meta',
  );
  assert.equal(targetPath(mod('b', { kind: 'asi' }), 'trainer.asi'), 'trainer.asi');
});

test('Definitive Edition paks deploy into the ~mods folder', () => {
  const pak = mod('de', { gameId: 'gtasade' as GameId, kind: 'pak' });
  assert.equal(
    targetPath(pak, 'MyMod_P.pak'),
    'Gameface/Content/Paks/~mods/MyMod_P.pak',
  );
});

test('later in the load order wins a contested file', () => {
  const a = mod('traffic');
  const b = mod('handling');
  const p = profile({ order: ['traffic', 'handling'], enabled: ['traffic', 'handling'] });

  const ordered = activeMods(p, [a, b]);
  const map = resolveFileMap(ordered);
  assert.equal(map.get('mods/common/data/handling.meta'), 'handling');

  const conflicts = findConflicts(ordered);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.winnerId, 'handling');
  assert.deepEqual(conflicts[0]?.modIds, ['traffic', 'handling']);
});

test('reordering changes the winner', () => {
  const a = mod('traffic');
  const b = mod('handling');
  const order = reorder(['traffic', 'handling'], 'traffic', 1);
  const p = profile({ order, enabled: order });
  assert.equal(findConflicts(activeMods(p, [a, b]))[0]?.winnerId, 'traffic');
});

test('disabled mods do not conflict', () => {
  const a = mod('traffic');
  const b = mod('handling');
  const p = profile({ order: ['traffic', 'handling'], enabled: ['handling'] });
  assert.equal(findConflicts(activeMods(p, [a, b])).length, 0);
});

test('a vanilla-locked profile deploys nothing at all', () => {
  const a = mod('traffic');
  const p = profile({ order: ['traffic'], enabled: ['traffic'], vanillaLock: true });
  assert.deepEqual(activeMods(p, [a]), []);
  assert.equal(resolveFileMap(activeMods(p, [a])).size, 0);
});

test('missing dependencies are reported', () => {
  const script = mod('lspdfr', { requires: ['scripthookv'] });
  const p = profile({ order: ['lspdfr'], enabled: ['lspdfr'] });
  const missing = missingDependencies(activeMods(p, [script]));
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.[1], 'scripthookv');
});

test('core mods sort to the top and misordering is detected', () => {
  const hook = mod('scripthookv', { core: true });
  const other = mod('trainer');
  const order = ['trainer', 'scripthookv'];
  assert.deepEqual(normaliseOrder(order, [hook, other]), ['scripthookv', 'trainer']);

  const p = profile({ order, enabled: order });
  assert.deepEqual(
    misorderedCoreMods(activeMods(p, [hook, other])).map((m) => m.id),
    ['trainer'],
  );
});

test('swap plan reports in, out and kept correctly', () => {
  const shared = mod('shared', { files: ['a.meta', 'b.meta'] });
  const onlyOld = mod('old', { files: ['old.meta'] });
  const onlyNew = mod('new', { files: ['new1.meta', 'new2.meta'] });
  const mods = [shared, onlyOld, onlyNew];

  const from = profile({
    id: 'from',
    name: 'Old',
    order: ['shared', 'old'],
    enabled: ['shared', 'old'],
  });
  const to = profile({
    id: 'to',
    name: 'New',
    order: ['shared', 'new'],
    enabled: ['shared', 'new'],
  });

  const plan = buildSwapPlan({
    gameId: 'gta5' as GameId,
    from,
    to,
    mods,
    manifest: null,
  });

  assert.equal(plan.filesOut, 1, 'the old-only mod leaves');
  assert.equal(plan.filesIn, 2, 'the new-only mod arrives');
  assert.equal(plan.filesKept, 2, 'the shared mod is untouched');

  // The destructive half of the plan is listed first.
  assert.equal(plan.entries[0]?.kind, 'out');
  assert.ok(plan.entries.some((e) => e.kind === 'keep' && e.modId === 'shared'));
});

test('a swap is blocked while the game is running', () => {
  const plan = buildSwapPlan({
    gameId: 'gta5' as GameId,
    from: null,
    to: profile(),
    mods: [],
    manifest: null,
    gameRunning: true,
  });
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0] ?? '', /running/i);
});

test('a swap is blocked when the disk is too small', () => {
  const big = mod('big', { size: 10_000, files: ['big.rpf'] });
  const to = profile({ order: ['big'], enabled: ['big'] });
  const plan = buildSwapPlan({
    gameId: 'gta5' as GameId,
    from: null,
    to,
    mods: [big],
    manifest: null,
    freeBytes: 100,
  });
  assert.ok(plan.blockers.some((b) => /free space/i.test(b)));
});

test('the online warning is opt-in, and silent by default', () => {
  const m = mod('trainer');
  const to = profile({ order: ['trainer'], enabled: ['trainer'] });
  const args = {
    gameId: 'gta5' as GameId,
    from: null,
    to,
    mods: [m],
    manifest: null,
  };

  // Off by default: GTA V asks story-or-online on every launch, so warning
  // on every swap is noise rather than safety.
  assert.equal(
    buildSwapPlan(args).warnings.some((w) => /online/i.test(w)),
    false,
  );

  assert.ok(
    buildSwapPlan({ ...args, warnAboutOnline: true }).warnings.some((w) => /online/i.test(w)),
  );
});

test('a running game is blocked and names the process', () => {
  const plan = buildSwapPlan({
    gameId: 'gta5' as GameId,
    from: null,
    to: profile(),
    mods: [],
    manifest: null,
    gameRunning: true,
    runningProcesses: ['gta5.exe'],
  });
  assert.match(plan.blockers[0] ?? '', /gta5\.exe/i);
});

test('byte formatting stays readable', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5_368_709_120), '5.0 GB');
});

test('two mods shipping a README is not reported as a conflict', () => {
  // The reported case: ScriptHookV .NET and ChaosMod both ship README.txt.
  // Flagging it is noise, and it buries conflicts that actually matter.
  const a = mod('shvdn', { files: ['ScriptHookVDotNet.asi', 'README.txt'] });
  const b = mod('chaosmod', { files: ['ChaosMod.asi', 'README.txt'] });
  const p = profile({ order: ['shvdn', 'chaosmod'], enabled: ['shvdn', 'chaosmod'] });

  assert.deepEqual(findConflicts(activeMods(p, [a, b])), []);
});

test('a real conflict is still reported alongside ignored documentation', () => {
  const a = mod('one', { files: ['README.txt', 'common/data/handling.meta'] });
  const b = mod('two', { files: ['README.txt', 'common/data/handling.meta'] });
  const p = profile({ order: ['one', 'two'], enabled: ['one', 'two'] });

  const conflicts = findConflicts(activeMods(p, [a, b]));
  assert.equal(conflicts.length, 1, 'only the meaningful one');
  assert.equal(conflicts[0]?.target, 'mods/common/data/handling.meta');
  assert.equal(conflicts[0]?.winnerId, 'two');
});

test('documentation and clutter are recognised', () => {
  for (const name of [
    'README.txt',
    'readme',
    'Read Me.txt',
    'LICENSE',
    'licence.md',
    'CHANGELOG.md',
    'HOW_TO_INSTALL_2026.txt',
    'credits.txt',
    'www.dev-c.com.url',
    'Thumbs.db',
    'desktop.ini',
    'readme_en.txt',
  ]) {
    assert.ok(isInertFile(name), `${name} should be ignored`);
  }
});

test('functional files are never mistaken for documentation', () => {
  // Each of these has burned somebody somewhere: args.txt is ScriptHookV's
  // command line, version.txt is read by mods, and ChaosMod's Twitch overlay
  // is genuinely .html.
  for (const name of [
    'args.txt',
    'version.txt',
    'ScriptHookV.dll',
    'ChaosMod.asi',
    'chaosmod/natives_def.lua',
    'chaosmod/twitchOverlay/index.html',
    'settings.ini',
    'commandline.txt',
    'common/data/handling.meta',
    'readme_parser.dll',
    'install_settings.xml',
  ]) {
    assert.ok(!isInertFile(name), `${name} must NOT be ignored`);
  }
});

test('documentation inside a folder is still recognised', () => {
  assert.ok(isInertFile('scripts/README.txt'));
  assert.ok(!isInertFile('scripts/config.txt'));
});

// --- per-file exclusions ----------------------------------------------------
//
// The Mod Organizer 2 feature: lose one file to another mod without unpacking
// the archive. The interesting cases are not "the file disappears" but what
// that does to the conflict it was losing or winning.

function exclusionFixture() {
  const mods: Mod[] = [
    mod('nve', {
      name: 'NaturalVision Evolved',
      files: ['common/data/timecycle.xml', 'x64/textures/road.ytd'],
    }),
    mod('roads', {
      name: 'Better Roads',
      files: ['x64/textures/road.ytd'],
    }),
  ];
  const p = profile({
    order: ['nve', 'roads'],
    enabled: ['nve', 'roads'],
  });
  return { mods, profile: p };
}

test('excluding a file removes it from what the mod deploys', () => {
  const { mods, profile } = exclusionFixture();
  profile.excludedFiles = { nve: ['x64/textures/road.ytd'] };
  const ordered = activeMods(profile, mods);
  const nve = ordered.find((m) => m.id === 'nve');
  assert.deepEqual(nve?.files, ['common/data/timecycle.xml']);
});

test('excluding a file does not disturb the original mod record', () => {
  const { mods, profile } = exclusionFixture();
  profile.excludedFiles = { nve: ['x64/textures/road.ytd'] };
  activeMods(profile, mods);
  assert.equal(mods[0]?.files.length, 2, 'the library entry is untouched');
});

test('excluding the losing side of a conflict resolves it', () => {
  // `roads` is later in the order, so it wins road.ytd. Switching that one
  // file off inside `roads` should hand the file back to NVE, not merely hide
  // the row - this is the whole reason to have the feature.
  const { mods, profile } = exclusionFixture();
  profile.excludedFiles = { roads: ['x64/textures/road.ytd'] };
  const ordered = activeMods(profile, mods);
  assert.deepEqual(findConflicts(ordered), [], 'nothing is contested any more');
  // Keyed by deploy target, so the "mods/" root for a replacement is included.
  const target = targetPath(mods[0]!, 'x64/textures/road.ytd');
  assert.equal(resolveFileMap(ordered).get(target), 'nve');
});

test('exclusions belong to the profile, not the mod', () => {
  // Two profiles sharing one mod must be able to disagree about it. If this
  // ever regresses, switching profiles silently rewrites the other one.
  const { mods } = exclusionFixture();
  const strict = profile({
    id: 'strict',
    order: ['nve'],
    enabled: ['nve'],
    excludedFiles: { nve: ['x64/textures/road.ytd'] },
  });
  const full = profile({ id: 'full', order: ['nve'], enabled: ['nve'] });

  assert.equal(activeMods(strict, mods)[0]?.files.length, 1);
  assert.equal(activeMods(full, mods)[0]?.files.length, 2);
});

test('an exclusion naming a file the mod does not have is harmless', () => {
  // Left behind after a mod is updated and reimported with a different layout.
  const { mods, profile } = exclusionFixture();
  profile.excludedFiles = { nve: ['x64/textures/gone.ytd'] };
  assert.equal(activeMods(profile, mods)[0]?.files.length, 2);
});

test('a mod with every file excluded deploys nothing but stays enabled', () => {
  const { mods, profile } = exclusionFixture();
  profile.excludedFiles = { roads: ['x64/textures/road.ytd'] };
  const ordered = activeMods(profile, mods);
  assert.ok(ordered.some((m) => m.id === 'roads'), 'still in the load order');
  assert.equal(ordered.find((m) => m.id === 'roads')?.files.length, 0);
});
