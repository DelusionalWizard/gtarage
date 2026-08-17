/**
 * Network access, all of it.
 *
 * The renderer has `default-src 'none'` and no Node, so every byte from the
 * internet arrives through this file. That makes it the right place to put
 * the rules:
 *
 *  - a host allowlist, so a compromised or merely wrong provider response
 *    cannot make Swapmeet fetch from somewhere unexpected;
 *  - a redirect chain that is re-checked at every hop, because the allowlist
 *    is worthless if the first response can bounce us anywhere;
 *  - hard timeouts and a size cap, so a hostile server cannot hang the app or
 *    fill the disk.
 */

import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ensureDir } from './fsutil';

export const USER_AGENT = 'Swapmeet/0.2.0 (+https://github.com/swapmeet-app/swapmeet)';

/** Hosts Swapmeet will talk to. Everything else is refused. */
const ALLOWED_HOSTS = new Set([
  // GitHub API and release assets (assets redirect to the *.githubusercontent hosts)
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  // Nexus Mods: the site and its download CDNs, for the embedded-browser
  // handoff. The API host is gone with the API integration.
  'www.nexusmods.com',
  'nexusmods.com',
  'file-cdn.nexusmods.com',
  'cf-files.nexusmods.com',
  'supporter-files.nexusmods.com',
  'premium-files.nexusmods.com',
]);

/** 4 GB: larger than any legitimate single mod file, small enough to matter. */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

function assertAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new NetworkError(`Refusing a non-HTTPS URL: ${parsed.protocol}//${parsed.host}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new NetworkError(`Refusing to contact an unexpected host: ${parsed.hostname}`);
  }
  return parsed;
}

/** GET JSON with a timeout. Throws NetworkError with the status on failure. */
export async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<T> {
  assertAllowed(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new NetworkError(
        `${response.status} ${response.statusText} from ${new URL(url).hostname}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof NetworkError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new NetworkError(`Timed out contacting ${new URL(url).hostname}`);
    }
    throw new NetworkError((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadProgress {
  received: number;
  total: number;
}

/**
 * Stream a file to disk.
 *
 * `fetch` follows redirects internally, which would let a first-hop response
 * escape the allowlist, so redirects are followed by hand and each hop is
 * re-checked before it is requested.
 */
export async function downloadFile(
  url: string,
  destDir: string,
  fileName: string,
  headers: Record<string, string> = {},
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  let current = assertAllowed(url);

  let response: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    response = await fetch(current.toString(), {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'manual',
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      // Re-check every hop: this is the whole point of manual redirects.
      current = assertAllowed(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!response) throw new NetworkError('No response.');
  if (!response.ok) {
    throw new NetworkError(`${response.status} ${response.statusText} downloading ${fileName}`, response.status);
  }
  if (!response.body) throw new NetworkError('Empty response body.');

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new NetworkError(
      `That file is ${Math.round(declared / 1e9)} GB, which is past the safety limit.`,
    );
  }

  await ensureDir(destDir);
  const dest = path.join(destDir, fileName);
  const partial = `${dest}.part`;

  let received = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  /*
   * Progress is measured by a Transform inside the pipeline, not by a `data`
   * listener on the source.
   *
   * This is not a style preference. Attaching `source.on('data', ...)` puts
   * the stream into flowing mode and makes it a second consumer alongside the
   * pipe; chunks then reach the file out of order. The result is a file of
   * exactly the right length whose contents are shuffled -- which for a ZIP
   * means the central directory is no longer where the header says it is, and
   * every download fails to import with a "damaged archive" error. A single
   * ordered pipeline is the only safe shape here.
   */
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        callback(new NetworkError('Download exceeded the size limit.'));
        return;
      }
      onProgress?.({ received, total: declared });
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, meter, createWriteStream(partial));
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw err;
  }

  // A truncated download that still parses is worse than an obvious failure,
  // so the byte count is checked against what the server promised.
  if (declared > 0 && received !== declared) {
    await fs.rm(partial, { force: true });
    throw new NetworkError(
      `${fileName} arrived incomplete (${received} of ${declared} bytes). Try again.`,
    );
  }

  // Only become the real file once it is complete, so an interrupted download
  // can never be mistaken for a finished one.
  await fs.rename(partial, dest);
  return dest;
}

/** A safe filename derived from an untrusted one. */
export function safeFileName(name: string): string {
  // Strip only what Windows actually forbids, plus control characters and
  // leading dots. Hyphens and spaces are legal and worth keeping readable.
  const cleaned = path
    .basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || 'download';
}
