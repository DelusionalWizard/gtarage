/**
 * Dev check: what would Swapmeet offer to adopt from each detected install?
 *
 * Read-only. Kept in the repo because the failure mode it guards against —
 * offering the game's own engine DLLs as mods — is invisible until you point
 * it at a real install.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findAdoptable } = require('../dist/main/adopt.js');
const { GAMES } = require('../dist/shared/games.js');
const { initConfig } = require('../dist/main/config.js');

const userData = path.join(process.env.APPDATA, 'swapmeet');
initConfig(userData);
const cfg = JSON.parse(readFileSync(path.join(userData, 'swapmeet.config.json'), 'utf8'));

for (const install of cfg.installs) {
  const groups = await findAdoptable(cfg, install.gameId, install.path);
  console.log(`\n=== ${GAMES[install.gameId].shortName}`);
  if (groups.length === 0) {
    console.log('  nothing unmanaged found');
    continue;
  }
  for (const g of groups) {
    console.log(
      `  ${g.name}  (${g.files.length} file(s)) ${g.alreadyInLibrary ? '[in library]' : ''}`,
    );
    for (const f of g.files.slice(0, 6)) console.log(`      ${f}`);
  }
}
