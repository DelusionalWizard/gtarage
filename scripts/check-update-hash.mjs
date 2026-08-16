/** Dev check: does the built installer match the checksum we publish? */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yml = readFileSync(path.join(root, 'release', 'latest.yml'), 'utf8');

const declared = yml.match(/^sha512:\s*(\S+)\s*$/m)?.[1];
const file = yml.match(/^path:\s*(.+?)\s*$/m)?.[1];
console.log('manifest names :', file);
console.log('declared sha512:', declared?.slice(0, 24) + '…');

const actual = await new Promise((resolve, reject) => {
  const hash = createHash('sha512');
  const stream = createReadStream(path.join(root, 'release', file));
  stream.on('error', reject);
  stream.on('data', (c) => hash.update(c));
  stream.on('end', () => resolve(hash.digest('base64')));
});

console.log('actual   sha512:', actual.slice(0, 24) + '…');
console.log('\nmatch:', actual === declared ? 'YES — the updater would accept this' : 'NO — it would be rejected');
