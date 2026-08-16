/** Dev check: what would setting up ScriptHookV from a game folder copy? */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findInstalledHook, findDownloadedHook } = require('../dist/main/scripthook.js');

const userData = path.join(process.env.APPDATA, 'swapmeet');
const cfg = JSON.parse(readFileSync(path.join(userData, 'swapmeet.config.json'), 'utf8'));

for (const c of [...(await findInstalledHook(cfg)), ...(await findDownloadedHook())]) {
  console.log(`\n${c.source}: ${c.path}`);
  if (c.files) {
    let bytes = 0;
    for (const f of c.files) {
      try {
        bytes += statSync(path.join(c.path, f)).size;
      } catch {
        /* ignore */
      }
    }
    console.log(`  would copy ${c.files.length} file(s), ${(bytes / 1048576).toFixed(2)} MB`);
    for (const f of c.files) console.log(`      ${f}`);
  } else {
    console.log('  would copy the archive itself');
  }
}
