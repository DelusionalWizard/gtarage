/** Dev check: what the ScriptHookV setup prompt would say right now. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hookCoverage, findDownloadedHook, findInstalledHook } = require('../dist/main/scripthook.js');
const { GAMES } = require('../dist/shared/games.js');
const { essentialsFor } = require('../dist/shared/catalog.js');

const userData = path.join(process.env.APPDATA, 'swapmeet');
const cfg = JSON.parse(readFileSync(path.join(userData, 'swapmeet.config.json'), 'utf8'));

const { missing, present } = hookCoverage(cfg);
const label = (g) => GAMES[g].shortName;

console.log('missing ScriptHookV :', missing.map(label).join(', ') || '(none)');
console.log('already has it      :', present.map(label).join(', ') || '(none)');
console.log(
  '\nprompt title        :',
  missing.length
    ? `${missing.map(label).join(' and ')} ${missing.length > 1 ? 'need' : 'needs'} ScriptHookV`
    : '(no prompt shown)',
);

const found = [...(await findInstalledHook(cfg)), ...(await findDownloadedHook())];
console.log('\ncopies found on this machine:', found.length);
for (const f of found) console.log(`  ${f.source}: ${f.path}  (gameId=${f.gameId})`);

console.log('\ncatalogue entries per game:');
for (const g of ['gta5', 'gta5e']) {
  console.log(`  ${label(g)}: ${essentialsFor(g).map((e) => e.id).join(', ')}`);
}
