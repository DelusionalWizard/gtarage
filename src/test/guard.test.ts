/**
 * The running-game guard must cover every operation that writes to the game
 * folder — not just "apply".
 *
 * This exists because it originally covered only `applyProfile`. Removing a
 * mod, or removing all mods, went straight to unlinking files while GTA V was
 * running with those very plugins loaded. Windows refuses, so it surfaced as
 * a raw `EPERM: operation not permitted, unlink '...ChaosMod.asi'` — after
 * the operation had already partly run, leaving some files gone, some still
 * there, and a manifest describing neither.
 *
 * A unit test cannot easily start GTA V, so this asserts the property
 * structurally: every handler that reaches the deployment engine also calls
 * the guard. That is the invariant that broke, and it is the one worth
 * pinning.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Compiled to CommonJS, so `__dirname` is dist/test; the source sits beside
// the repo root. Reading the TypeScript rather than the build keeps the
// assertion about what a maintainer edits.
const apiSource = readFileSync(
  path.resolve(__dirname, '../../src/main/api.ts'),
  'utf8',
);

/** Extract one handler's body from api.ts by name. */
function handlerBody(name: string): string {
  const start = apiSource.indexOf(`  async ${name}(`);
  assert.notEqual(start, -1, `handler ${name} not found in api.ts`);
  // Handlers are two-space indented; the next one starts at the same depth.
  const rest = apiSource.slice(start + 10);
  const end = rest.search(/\n {2}async [a-zA-Z]+\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Handlers that delete or overwrite files inside the game folder. */
const MUTATING_HANDLERS = ['applyProfile', 'undeployAll', 'removeMod'];

for (const name of MUTATING_HANDLERS) {
  test(`${name} refuses to run while the game is running`, () => {
    const body = handlerBody(name);
    assert.ok(
      body.includes('assertGameNotRunning'),
      `${name} writes to the game folder but never calls assertGameNotRunning. ` +
        'Windows will not let a running game\'s files be deleted, so this fails ' +
        'mid-operation with EPERM and leaves a half-undeployed install.',
    );
  });
}

test('the guard is honoured before any deployment work begins', () => {
  // Guarding after the files have already moved would be pointless.
  for (const name of MUTATING_HANDLERS) {
    const body = handlerBody(name);
    const guard = body.indexOf('assertGameNotRunning');
    const deploy = Math.min(
      ...['deployProfile(', 'undeployAll(', 'snapshotSaves(']
        .map((call) => body.indexOf(call))
        .filter((i) => i !== -1)
        .concat([Number.MAX_SAFE_INTEGER]),
    );
    if (deploy !== Number.MAX_SAFE_INTEGER) {
      assert.ok(guard < deploy, `${name} checks the guard after it starts moving files`);
    }
  }
});

test('read-only operations are not needlessly blocked', () => {
  // `adopt` and `installHook` only copy *out of* the game folder, and
  // `verify` only reads. Blocking those while the game runs would be
  // over-restrictive for no safety gain.
  for (const name of ['adopt', 'verify']) {
    assert.ok(
      !handlerBody(name).includes('assertGameNotRunning'),
      `${name} only reads the game folder and should not be blocked`,
    );
  }
});
