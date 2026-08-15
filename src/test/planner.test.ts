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
