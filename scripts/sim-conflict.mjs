/** Simulate the reported ScriptHookV .NET vs chaosmod README overlap. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { activeMods, findConflicts, isInertFile, targetPath } = require('../dist/shared/planner.js');

const base = (id, files) => ({
  id,
  gameId: 'gta5',
  name: id,
  kind: 'asi',
  version: '1',
  path: '/l/' + id,
  files,
  size: 1,
  addedAt: '2026-01-01T00:00:00.000Z',
  category: 'core',
  requires: [],
  core: false,
});

const shvdn = base('ScriptHookV .NET', [
  'ScriptHookVDotNet.asi',
  'ScriptHookVDotNet3.dll',
  'README.txt',
  'LICENSE',
]);
const chaos = base('chaosmod', [
  'ChaosMod.asi',
  'README.txt',
  'LICENSE',
  'chaosmod/version.txt',
  'chaosmod/config.ini',
]);

const profile = {
  id: 'p',
  gameId: 'gta5',
  name: 'Chaos',
  order: ['ScriptHookV .NET', 'chaosmod'],
  enabled: ['ScriptHookV .NET', 'chaosmod'],
  createdAt: '',
  vanillaLock: false,
};

const ordered = activeMods(profile, [shvdn, chaos]);
const claims = new Map();
for (const m of ordered) {
  for (const f of m.files) {
    const t = targetPath(m, f);
    claims.set(t, [...(claims.get(t) || []), m.name]);
  }
}

console.log('overlapping files:');
for (const [t, names] of [...claims].filter(([, n]) => n.length > 1)) {
  console.log(`   ${isInertFile(t) ? 'ignored ' : 'REPORTED'}  ${t}   (${names.join(' vs ')})`);
}
console.log('\nconflicts shown to the user:', findConflicts(ordered).length);
