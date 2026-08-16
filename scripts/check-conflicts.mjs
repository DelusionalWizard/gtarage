/** Dev check: what conflicts does the real library report? */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { activeMods, findConflicts, isInertFile, targetPath } = require('../dist/shared/planner.js');

const userData = path.join(process.env.APPDATA, 'swapmeet');
const cfg = JSON.parse(readFileSync(path.join(userData, 'swapmeet.config.json'), 'utf8'));

for (const profile of cfg.profiles.filter((p) => !p.vanillaLock)) {
  const mods = cfg.mods.filter((m) => m.gameId === profile.gameId);
  const ordered = activeMods(profile, mods);
  if (ordered.length === 0) continue;

  console.log(`\n=== "${profile.name}" (${ordered.length} mods on)`);

  // Every overlap, before filtering, so we can show what got ignored.
  const claims = new Map();
  for (const m of ordered) {
    for (const f of m.files) {
      const t = targetPath(m, f);
      claims.set(t, [...(claims.get(t) ?? []), m.name]);
    }
  }
  const overlaps = [...claims].filter(([, names]) => names.length > 1);

  console.log(`  raw overlaps : ${overlaps.length}`);
  for (const [t, names] of overlaps) {
    console.log(`     ${isInertFile(t) ? 'ignored ' : 'REPORTED'} ${t}  (${names.join(' vs ')})`);
  }
  console.log(`  reported     : ${findConflicts(ordered).length}`);
}
