/** Print the live Essentials catalogue for each game. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { browseEssentials } = require('../dist/main/providers/github.js');
const { GAMES } = require('../dist/shared/games.js');

const games = process.argv.slice(2);
for (const g of games.length ? games : ['gta5e', 'gta5']) {
  const mods = await browseEssentials(g, '');
  console.log(`\n=== ${GAMES[g].shortName}  (${mods.length} entries)`);
  for (const m of mods) {
    const primary = m.files.find((f) => f.primary);
    const detail = m.manualOnly
      ? 'manual link-out'
      : primary
        ? `${primary.name} (${(primary.size / 1048576).toFixed(2)} MB)`
        : 'no files';
    console.log(`  ${m.name.padEnd(30)} ${String(m.version).padEnd(14)} ${detail}`);
  }
}
