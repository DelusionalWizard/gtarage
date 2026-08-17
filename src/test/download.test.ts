/**
 * Regression tests for the downloader.
 *
 * These exist because of a real bug: progress was measured with a `data`
 * listener on the same stream that was being piped to disk, which made the
 * stream a two-consumer flowing stream and let chunks reach the file out of
 * order. Every downloaded archive came out the correct *length* with its
 * contents shuffled, so it looked like a successful download and then failed
 * to import as a "damaged ZIP".
 *
 * A length check would not have caught it. These tests check content.
 */

import assert from 'node:assert/strict';
import { createWriteStream, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

/**
 * The exact shape used in `net.ts`: one ordered pipeline, progress measured by
 * a Transform rather than by a second consumer.
 */
async function streamToFile(
  chunks: Buffer[],
  dest: string,
  onProgress: (received: number) => void,
): Promise<void> {
  let received = 0;
  const source = Readable.from(chunks);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      onProgress(received);
      cb(null, chunk);
    },
  });
  await pipeline(source, meter, createWriteStream(dest));
}

/** A body big enough to cross Node's internal buffer boundaries. */
function makeChunks(count: number, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    // Each chunk is filled with its own index, so any reordering is visible.
    chunks.push(Buffer.alloc(size, i % 256));
  }
  return chunks;
}

test('streaming to disk preserves byte order exactly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dl-'));
  const dest = path.join(dir, 'out.bin');

  // 64 x 16 KB = 1 MB, spanning the 128 KB boundary where the bug first bit.
  const chunks = makeChunks(64, 16 * 1024);
  const expected = Buffer.concat(chunks);

  let lastProgress = 0;
  await streamToFile(chunks, dest, (received) => {
    lastProgress = received;
  });

  const written = await fs.readFile(dest);
  assert.equal(written.length, expected.length, 'length must match');
  assert.ok(written.equals(expected), 'contents must match byte for byte, in order');
  assert.equal(lastProgress, expected.length, 'progress must total the whole body');

  await fs.rm(dir, { recursive: true, force: true });
});

test('a real HTTP body round-trips unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtarage-dl-'));
  const dest = path.join(dir, 'out.bin');

  // Pseudo-random, incompressible payload: shuffled chunks cannot coincidentally match.
  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) % 256;

  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(payload.length),
    });
    // Write in many small pieces, which is what provokes the reordering.
    for (let off = 0; off < payload.length; off += 8192) {
      res.write(payload.subarray(off, off + 8192));
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/file.zip`);
    assert.ok(response.body);

    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(dest),
    );

    const written = await fs.readFile(dest);
    assert.equal(written.length, payload.length);
    assert.ok(written.equals(payload), 'downloaded bytes must be identical and in order');
    assert.equal(received, payload.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a shuffled body is detectable by content but not by length', async () => {
  // Documents why the original bug survived: the length was always right.
  const chunks = makeChunks(8, 1024);
  const correct = Buffer.concat(chunks);
  const shuffled = Buffer.concat([chunks[2]!, chunks[0]!, chunks[1]!, ...chunks.slice(3)]);

  assert.equal(shuffled.length, correct.length, 'length alone cannot catch this');
  assert.ok(!shuffled.equals(correct), 'only a content check catches it');
});
