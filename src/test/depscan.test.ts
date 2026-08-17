/**
 * Tests for dependency detection.
 *
 * The PE parser is checked against a real Windows binary rather than a
 * hand-built fixture: the whole claim of this feature is that it reads what
 * the OS loader reads, and only a genuine executable proves that.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  annotateSatisfied,
  missingDependencies,
  readPeImports,
  scanDependencies,
} from '../main/depscan';
import type { Mod, ModDependency } from '../shared/types';

function mod(over: Partial<Mod> = {}): Mod {
  return {
    id: 'm',
    gameId: 'gta5',
    name: 'Test Mod',
    kind: 'script',
    version: '1.0',
    path: '/library/m',
    files: [],
    size: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    category: 'scripts',
    requires: [],
    core: false,
    ...over,
  };
}

test('reads the import table of a real Windows binary', async (t) => {
  // Any of these will do; CI on other platforms simply skips.
  const candidates = [
    'C:/Windows/System32/notepad.exe',
    'C:/Windows/System32/kernel32.dll',
    'C:/Windows/notepad.exe',
  ];
  let target: string | null = null;
  for (const c of candidates) {
    try {
      await fs.access(c);
      target = c;
      break;
    } catch {
      // next
    }
  }
  if (!target) return t.skip('no Windows binary available');

  const buf = await fs.readFile(target);
  const imports = readPeImports(buf);

  assert.ok(imports.length > 0, `expected imports from ${target}`);
  assert.ok(
    imports.some((name) => /\.dll$/i.test(name)),
    `expected DLL names, got ${imports.join(', ')}`,
  );
});

test('non-PE input yields no imports rather than throwing', () => {
  assert.deepEqual(readPeImports(Buffer.from('not an executable')), []);
  assert.deepEqual(readPeImports(Buffer.alloc(0)), []);
  // An MZ header with nothing behind it must not crash the walker.
  const stub = Buffer.alloc(64);
  stub.writeUInt16LE(0x5a4d, 0);
  stub.writeUInt32LE(0x1000, 0x3c);
  assert.deepEqual(readPeImports(stub), []);
});

test('an .asi implies an ASI loader', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(path.join(dir, 'trainer.asi'), 'not really a binary');

  const deps = await scanDependencies(dir, ['trainer.asi'], 'gta5');
  assert.ok(deps.some((d) => d.capability === 'asiloader'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('a managed assembly referencing SHVDN implies SHVDN and ScriptHookV', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  // The assembly-reference name appears as ASCII in the metadata heap.
  await fs.writeFile(path.join(dir, 'MyScript.dll'), 'padding ScriptHookVDotNet3 padding');

  const deps = await scanDependencies(dir, ['MyScript.dll'], 'gta5');
  assert.ok(deps.some((d) => d.capability === 'shvdn'), 'expected SHVDN');
  assert.ok(deps.some((d) => d.capability === 'scripthookv'), 'expected ScriptHookV');
  await fs.rm(dir, { recursive: true, force: true });
});

test('CLEO scripts imply CLEO, and only on games that have it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(path.join(dir, 'script.cs'), 'cleo script');

  const sa = await scanDependencies(dir, ['script.cs'], 'gtasa');
  assert.ok(sa.some((d) => d.capability === 'cleo'));

  // ...but not on GTA V, which has no CLEO at all. `.cs` is also the extension
  // of every C# source file, and SHVDN mods routinely ship their source, so
  // this used to tell GTA V users to install a runtime their game cannot use.
  const v = await scanDependencies(dir, ['script.cs'], 'gta5');
  assert.ok(
    !v.some((d) => d.capability === 'cleo'),
    'a .cs file on GTA V is C# source, not a CLEO script',
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('Lua in a Definitive Edition mod implies UE4SS', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(path.join(dir, 'main.lua'), 'print("hi")');

  const de = await scanDependencies(dir, ['main.lua'], 'gtasade');
  assert.ok(de.some((d) => d.capability === 'ue4ss'));

  // The same file on GTA V should not claim UE4SS, which does not apply.
  const v = await scanDependencies(dir, ['main.lua'], 'gta5');
  assert.ok(!v.some((d) => d.capability === 'ue4ss'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('a readme naming a requirement is picked up', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(
    path.join(dir, 'readme.txt'),
    'Installation: you must have ScriptHookV installed first.',
  );

  const deps = await scanDependencies(dir, ['readme.txt'], 'gta5');
  assert.ok(deps.some((d) => d.capability === 'scripthookv'));
  // The evidence is recorded, so the user can weigh it.
  const dep = deps.find((d) => d.capability === 'scripthookv')!;
  assert.match(dep.reason, /readme/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a tool does not depend on itself', async () => {
  // ScriptHookVDotNet ships ScriptHookVDotNet.asi, whose metadata naturally
  // references the ScriptHookVDotNet assembly. Reporting that as a missing
  // prerequisite told the user to install the thing they had just installed.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(path.join(dir, 'ScriptHookVDotNet.asi'), 'x ScriptHookVDotNet3 x');

  const deps = await scanDependencies(dir, ['ScriptHookVDotNet.asi'], 'gta5');
  assert.ok(
    !deps.some((d) => d.capability === 'shvdn'),
    'must not require the capability it provides',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('the ASI loader does not require an ASI loader', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dep-'));
  await fs.writeFile(path.join(dir, 'dinput8.dll'), 'proxy loader');

  const deps = await scanDependencies(dir, ['dinput8.dll'], 'gta5');
  assert.ok(!deps.some((d) => d.capability === 'asiloader'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('self-provision is re-checked at read time for older library entries', () => {
  // Simulates a mod indexed before the fix, carrying a bogus self-dependency.
  const shvdn = mod({
    id: 'shvdn',
    name: 'ScriptHookVDotNet',
    files: ['ScriptHookVDotNet.asi', 'ScriptHookVDotNet3.dll'],
    dependencies: [
      { capability: 'shvdn', label: 'ScriptHookV .NET', reason: 'references the assembly' },
    ],
  });
  assert.deepEqual(missingDependencies(shvdn, [shvdn]), []);
});

test('dependencies already in the library are marked satisfied', () => {
  const deps: ModDependency[] = [
    { capability: 'scripthookv', label: 'ScriptHookV', reason: 'imports it' },
  ];
  const library = [mod({ id: 'shv', name: 'ScriptHookV' })];

  const annotated = annotateSatisfied(deps, library);
  assert.equal(annotated[0]?.satisfiedBy, 'shv');
});

test('ScriptHookV in the library does not satisfy a need for SHVDN', () => {
  const deps: ModDependency[] = [
    { capability: 'shvdn', label: 'ScriptHookV .NET', reason: 'references it' },
  ];
  const library = [mod({ id: 'shv', name: 'ScriptHookV' })];
  assert.equal(annotateSatisfied(deps, library)[0]?.satisfiedBy, undefined);
});

test('missing dependencies ignore optional ones and the mod itself', () => {
  const subject = mod({
    id: 'lspdfr',
    name: 'LSPDFR',
    dependencies: [
      { capability: 'scripthookv', label: 'ScriptHookV', reason: 'imports it' },
      { capability: 'openiv', label: 'OpenIV', reason: 'assets', optional: true },
    ],
  });

  assert.deepEqual(
    missingDependencies(subject, [subject]).map((d) => d.capability),
    ['scripthookv'],
    'optional deps are not reported as missing',
  );

  const withHook = [subject, mod({ id: 'shv', name: 'ScriptHookV' })];
  assert.deepEqual(missingDependencies(subject, withHook), []);
});
