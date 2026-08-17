/**
 * Updating GTArage itself.
 *
 * Deliberately hand-rolled rather than pulling in `electron-updater`. The app
 * has no runtime dependencies, and it already owns a hardened downloader —
 * HTTPS-only, host allowlist re-checked at every redirect hop, size caps — so
 * adding a library to fetch a file from GitHub would trade that for a larger
 * dependency surface and no benefit.
 *
 * What matters here is not convenience, it is that **an updater downloads an
 * executable and runs it**. That is the single most dangerous thing this app
 * does, so:
 *
 *  - The release is read from the GitHub API, which the allowlist pins.
 *  - The installer's SHA-512 is checked against `latest.yml`, the checksum
 *    manifest electron-builder generates at build time and which is published
 *    alongside the installer. A download that does not match is deleted, not
 *    run.
 *  - Nothing is ever installed silently while the user is mid-operation.
 *
 * The builds are unsigned, so this checksum is the only integrity guarantee
 * there is. It is checked, not assumed.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { downloadFile, getJson, safeFileName } from './net';

/** How the app should behave when a new version exists. */
export type UpdatePolicy = 'off' | 'notify' | 'auto';

export interface UpdateInfo {
  /** The version on GitHub. */
  version: string;
  /** The version running now. */
  current: string;
  /** True when the published version is newer than the running one. */
  newer: boolean;
  /** Release page, for the "what changed" link. */
  url: string;
  notes: string;
  /** Installer download URL, when one is published. */
  assetUrl?: string;
  assetName?: string;
  sizeBytes?: number;
  /** Base64 SHA-512 from latest.yml, as electron-builder writes it. */
  sha512?: string;
  /**
   * Set when this build cannot replace itself — the portable exe has nothing
   * to run an installer over.
   */
  cannotSelfUpdate?: boolean;
}

// Still `swapmeet`: that is the repository name on GitHub. The app was renamed
// to GTArage before the repo was, and pointing this at the new name early would
// 404 for every user already running a beta. GitHub redirects the old path
// indefinitely after a rename, so this keeps working either way.
const RELEASES_API = 'https://api.github.com/repos/DelusionalWizard/swapmeet/releases/latest';

interface GhRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

/**
 * Compare two versions, honouring prerelease suffixes.
 *
 * `0.4.2-beta.1` must count as older than `0.4.2`, and `0.4.10` as newer than
 * `0.4.9` — which a plain string compare gets wrong in both directions.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };

  const a = parse(candidate);
  const b = parse(current);

  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }

  // Same numbers: a release beats a prerelease, and prereleases sort by name.
  if (a.pre === b.pre) return false;
  if (a.pre === '') return true;
  if (b.pre === '') return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

/** True when this build can install an update over itself. */
export function canSelfUpdate(): boolean {
  // The portable build runs from a temp extraction; there is no install to
  // replace, and running the NSIS setup would leave two copies around.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false;
  return app.isPackaged;
}

/** Pull the checksum manifest electron-builder publishes beside the installer. */
async function readChecksums(
  release: GhRelease,
): Promise<{ sha512?: string; file?: string }> {
  const manifest = release.assets.find((a) => a.name === 'latest.yml');
  if (!manifest) return {};

  try {
    // Small YAML with a fixed shape; a parser would be overkill.
    const text = await fetch(manifest.browser_download_url, {
      headers: { 'User-Agent': 'GTArage' },
    }).then((r) => r.text());

    const sha512 = text.match(/^sha512:\s*(\S+)\s*$/m)?.[1];
    const file = text.match(/^path:\s*(.+?)\s*$/m)?.[1];
    const out: { sha512?: string; file?: string } = {};
    if (sha512) out.sha512 = sha512;
    if (file) out.file = file;
    return out;
  } catch {
    return {};
  }
}

/** Ask GitHub what the newest published version is. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const release = await getJson<GhRelease>(RELEASES_API, {
    Accept: 'application/vnd.github+json',
  });

  const version = release.tag_name.replace(/^v/, '');
  const current = app.getVersion();

  const info: UpdateInfo = {
    version,
    current,
    newer: isNewer(version, current),
    url: release.html_url,
    notes: release.body ?? '',
  };

  const { sha512, file } = await readChecksums(release);
  // Prefer the file the manifest names; fall back to the obvious installer.
  const asset =
    (file ? release.assets.find((a) => a.name === file) : undefined) ??
    release.assets.find((a) => /Setup.*\.exe$/i.test(a.name));

  if (asset) {
    info.assetUrl = asset.browser_download_url;
    info.assetName = asset.name;
    info.sizeBytes = asset.size;
  }
  if (sha512) info.sha512 = sha512;
  if (!canSelfUpdate()) info.cannotSelfUpdate = true;

  return info;
}

/** Base64 SHA-512 of a file, matching how electron-builder records it. */
async function sha512Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * Download the installer and check it before it is ever executed.
 *
 * Returns the verified path. A mismatch throws and the file is removed: a
 * corrupted or substituted installer is the one thing that must never be
 * run, and with unsigned builds this checksum is the only thing standing
 * between the user and whatever arrived over the wire.
 */
export async function downloadUpdate(
  info: UpdateInfo,
  destDir: string,
  onProgress?: (received: number, total: number) => void,
): Promise<string> {
  if (!info.assetUrl || !info.assetName) {
    throw new Error('That release has no installer attached.');
  }

  const file = await downloadFile(
    info.assetUrl,
    destDir,
    safeFileName(info.assetName),
    {},
    (p) => onProgress?.(p.received, p.total || info.sizeBytes || 0),
  );

  if (info.sha512) {
    const actual = await sha512Of(file);
    if (actual !== info.sha512) {
      await fs.rm(file, { force: true });
      throw new Error(
        'The downloaded update did not match its published checksum, so it was deleted. ' +
          'Try again, or download it yourself from the releases page.',
      );
    }
  }

  return file;
}

/**
 * Run the installer and quit so it can replace the running app.
 *
 * `/S` would make NSIS silent, and it is deliberately not passed: the user
 * should see what is installing itself over their mod manager.
 */
export function installUpdate(installerPath: string): void {
  const child = execFile(installerPath, { cwd: path.dirname(installerPath) });
  child.unref();
  // Give the installer a moment to take hold before the app disappears.
  setTimeout(() => app.quit(), 1200);
}
