/**
 * The mod browser's orchestration layer.
 *
 * Providers know how to list mods; this file knows what to do with the
 * result: mark what is already installed, download a chosen file, and hand it
 * to the existing importer so a browsed mod ends up in exactly the same state
 * as one dragged in from disk.
 *
 * Downloads always land in a staging folder and are imported from there. The
 * library never receives a file that did not finish downloading.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  BrowseQuery,
  BrowseResult,
  CatalogFile,
  CatalogMod,
} from '../shared/catalog';
import type { AppConfig, GameId, Mod } from '../shared/types';
import { shelfFor } from './config';
import { downloadFile, safeFileName } from './net';
import { browseEssentials, clearEssentialsCache } from './providers/github';
import {
  NexusAuthError,
  browseNexus,
  decryptKey,
  nexusDownloadLink,
  nexusFiles,
} from './providers/nexus';

/** Where a game's in-flight downloads are staged. */
export function stagingDir(config: AppConfig, gameId: GameId): string {
  return path.join(shelfFor(config, gameId), 'downloads');
}

/**
 * Mark catalog entries that are already in the library.
 *
 * Matching is by normalised name: providers have no notion of Swapmeet's mod
 * ids, and names are what a user recognises. Imperfect, but it only drives a
 * badge and an "update available" hint, never a destructive action.
 */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function markInstalled(mods: CatalogMod[], library: Mod[]): CatalogMod[] {
  const byName = new Map(library.map((m) => [normalise(m.name), m]));
  return mods.map((mod) => {
    const hit = byName.get(normalise(mod.name));
    if (!hit) return mod;
    return { ...mod, installedModId: hit.id, installedVersion: hit.version };
  });
}

export async function browse(
  config: AppConfig,
  query: BrowseQuery,
  library: Mod[],
): Promise<BrowseResult> {
  try {
    if (query.providerId === 'essentials') {
      const mods = await browseEssentials(query.gameId, query.search);
      return { mods: markInstalled(mods, library) };
    }

    const apiKey = decryptKey(config.nexusApiKey);
    if (!apiKey) {
      return {
        mods: [],
        needsSetup: true,
        error:
          'Nexus needs a personal API key. Add one in Settings, or use the built-in browser to visit Nexus and log in normally.',
      };
    }

    const mods = await browseNexus(query.gameId, query.sort, query.search, apiKey);
    return { mods: markInstalled(mods, library) };
  } catch (err) {
    if (err instanceof NexusAuthError) {
      return { mods: [], needsSetup: true, error: err.message };
    }
    return { mods: [], error: (err as Error).message };
  }
}

/** Files for a mod, fetched lazily because Nexus needs a second call. */
export async function catalogFiles(
  config: AppConfig,
  mod: CatalogMod,
  gameId: GameId,
): Promise<CatalogFile[]> {
  if (mod.providerId === 'essentials') return mod.files;
  const apiKey = decryptKey(config.nexusApiKey);
  if (!apiKey) throw new NexusAuthError('No Nexus API key set.');
  return nexusFiles(gameId, mod.id, apiKey);
}

export interface FetchResult {
  /** Absolute path of the staged file. */
  filePath: string;
  fileName: string;
  /** True when the file is an installer that must not be auto-imported. */
  executable: boolean;
}

/**
 * Download one catalog file into staging.
 *
 * Essentials files carry a direct URL from the GitHub release. Nexus files
 * need a link resolved first, which only succeeds for Premium accounts; the
 * caller turns the resulting error into "open the mod page instead".
 */
export async function fetchCatalogFile(
  config: AppConfig,
  gameId: GameId,
  mod: CatalogMod,
  file: CatalogFile,
  onProgress: (received: number, total: number) => void,
): Promise<FetchResult> {
  let url = file.url;

  if (!url) {
    if (mod.providerId !== 'nexus') {
      throw new Error(`${file.name} has no download URL.`);
    }
    const apiKey = decryptKey(config.nexusApiKey);
    if (!apiKey) throw new NexusAuthError('No Nexus API key set.');
    url = await nexusDownloadLink(gameId, mod.id, file.id, apiKey);
  }

  const dir = stagingDir(config, gameId);
  const fileName = safeFileName(file.name);
  const filePath = await downloadFile(url, dir, fileName, {}, (p) =>
    onProgress(p.received, p.total || file.size),
  );

  return {
    filePath,
    fileName,
    executable: /\.(exe|msi|bat|cmd|ps1|scr|com)$/i.test(fileName),
  };
}

/** Drop a staged download once it has been imported. */
export async function clearStaged(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

/** Forget cached release metadata so a refresh really refetches. */
export function invalidateCaches(): void {
  clearEssentialsCache();
}
