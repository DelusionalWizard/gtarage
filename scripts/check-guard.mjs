/** Dev check: does the running-game guard fire right now? */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isGameRunning, runningGameProcesses } = require('../dist/main/deploy.js');
const { GAMES } = require('../dist/shared/games.js');

for (const g of ['gta5', 'gta5e']) {
  const running = await isGameRunning(g);
  const procs = await runningGameProcesses(g);
  console.log(
    `${GAMES[g].shortName.padEnd(16)} running=${String(running).padEnd(5)} matched=[${procs.join(', ')}]`,
  );
}
