// Copies non-TS renderer assets (HTML/CSS) into dist/ after tsc runs.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src/renderer/assets');
const to = resolve(root, 'dist/renderer/assets');

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log('assets -> dist/renderer/assets');
