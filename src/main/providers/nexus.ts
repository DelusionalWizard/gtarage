/**
 * The Nexus Mods provider, using the official public API.
 *
 * Nexus is the one big mod host with a documented API, so it gets a proper
 * in-app listing rather than only a browser window. It needs the user's own
 * personal API key, which they generate on their Nexus account page.
 *
 * Two honest limitations, surfaced in the UI rather than papered over:
 *
 *  - **There is no full-text search in the v1 API.** It exposes curated feeds
 *    (trending, latest added, latest updated) and per-mod lookups. Swapmeet
 *    filters those feeds locally, so the search box narrows what is on screen
 *    rather than querying the whole site. For a real search, the embedded
 *    browser is the right tool.
 *  - **Direct download links are a Premium feature.** For everyone else the
 *    API returns 403, and the supported path is the `nxm://` handshake that
 *    starts from the site's own "Mod Manager Download" button. Swapmeet
 *    registers that protocol and falls back to opening the mod page.
 */

import { safeStorage } from 'electron';

import { NEXUS_DOMAINS, type BrowseSort, type CatalogFile, type CatalogMod } from '../../shared/catalog';
import type { GameId } from '../../shared/types';
import { NetworkError, getJson } from '../net';

const API = 'https://api.nexusmods.com/v1';

interface NexusModSummary {
  mod_id: number;
  name: string | null;
  summary: string | null;
  version: string | null;
  author: string | null;
  uploaded_by: string | null;
  category_id: number;
  updated_time: string;
  endorsement_count: number;
  available: boolean;
  domain_name: string;
}

interface NexusFile {
  file_id: number;
  name: string;
  version: string;
  size_in_bytes: number | null;
  size: number;
  description: string | null;
  category_name: string | null;
  is_primary: boolean;
}

export class NexusAuthError extends Error {}

// --- key storage ------------------------------------------------------------

/**
 * The API key is stored encrypted with the OS keychain (DPAPI on Windows)
 * when that is available, so it is not sitting in plaintext in a JSON file
 * that gets copied around with a profile backup.
 */
export function encryptKey(key: string): string {
  if (!key) return '';
  if (!safeStorage.isEncryptionAvailable()) return `plain:${key}`;
  return `enc:${safeStorage.encryptString(key).toString('base64')}`;
}

export function decryptKey(stored: string | undefined): string {
  if (!stored) return '';
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (!stored.startsWith('enc:')) return stored; // legacy plaintext
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  } catch {
    return '';
  }
}

function headers(apiKey: string): Record<string, string> {
  return { apikey: apiKey, Accept: 'application/json' };
}

// --- api calls --------------------------------------------------------------

export interface NexusAccount {
  name: string;
  premium: boolean;
  supporter: boolean;
}

/** Confirm a key works and report what it can do. */
export async function validateKey(apiKey: string): Promise<NexusAccount> {
  try {
    const user = await getJson<{
      name: string;
      is_premium: boolean;
      is_supporter: boolean;
    }>(`${API}/users/validate.json`, headers(apiKey));
    return {
      name: user.name,
      premium: Boolean(user.is_premium),
      supporter: Boolean(user.is_supporter),
    };
  } catch (err) {
    if (err instanceof NetworkError && (err.status === 401 || err.status === 403)) {
      throw new NexusAuthError('That API key was rejected by Nexus.');
    }
    throw err;
  }
}

const FEEDS: Record<BrowseSort, string> = {
  trending: 'trending',
  latest: 'latest_added',
  updated: 'latest_updated',
};

function toCatalogMod(summary: NexusModSummary, domain: string): CatalogMod {
  return {
    providerId: 'nexus',
    id: String(summary.mod_id),
    name: summary.name ?? `Mod ${summary.mod_id}`,
    summary: summary.summary ?? '',
    author: summary.author ?? summary.uploaded_by ?? 'unknown',
    version: summary.version ?? '—',
    url: `https://www.nexusmods.com/${domain}/mods/${summary.mod_id}`,
    category: 'nexus',
    updatedAt: summary.updated_time,
    endorsements: summary.endorsement_count,
    files: [],
  };
}

/**
 * A feed of mods for a game.
 *
 * `search` filters the feed locally; see the note at the top of this file.
 */
export async function browseNexus(
  gameId: GameId,
  sort: BrowseSort,
  search: string,
  apiKey: string,
): Promise<CatalogMod[]> {
  const domain = NEXUS_DOMAINS[gameId];
  if (!domain) {
    throw new Error(
      'Swapmeet does not have a confirmed Nexus game domain for this title, so it will not guess one. Use the built-in browser instead.',
    );
  }
  if (!apiKey) throw new NexusAuthError('No Nexus API key set.');

  const feed = FEEDS[sort];
  let list: NexusModSummary[];
  try {
    list = await getJson<NexusModSummary[]>(
      `${API}/games/${domain}/mods/${feed}.json`,
      headers(apiKey),
    );
  } catch (err) {
    if (err instanceof NetworkError && (err.status === 401 || err.status === 403)) {
      throw new NexusAuthError('Nexus rejected the API key. Check it in Settings.');
    }
    throw err;
  }

  const mods = list
    .filter((m) => m.available !== false)
    .map((m) => toCatalogMod(m, domain));

  const needle = search.trim().toLowerCase();
  if (!needle) return mods;
  return mods.filter((m) =>
    `${m.name} ${m.summary} ${m.author}`.toLowerCase().includes(needle),
  );
}

/** The downloadable files for one mod, fetched when the user opens it. */
export async function nexusFiles(
  gameId: GameId,
  modId: string,
  apiKey: string,
): Promise<CatalogFile[]> {
  const domain = NEXUS_DOMAINS[gameId];
  if (!domain) return [];

  const response = await getJson<{ files: NexusFile[] }>(
    `${API}/games/${domain}/mods/${modId}/files.json`,
    headers(apiKey),
  );

  return response.files.map((f) => ({
    id: String(f.file_id),
    name: f.name,
    size: f.size_in_bytes ?? f.size * 1024,
    executable: /\.(exe|msi)$/i.test(f.name),
    description: f.description?.replace(/<[^>]*>/g, '') ?? '',
    primary: Boolean(f.is_primary),
  }));
}

/**
 * Resolve a direct download URL.
 *
 * Works for Premium accounts. For everyone else Nexus returns 403 by design,
 * and the caller falls back to opening the mod page so the user can use the
 * site's own download button (which comes back to us over `nxm://`).
 */
export async function nexusDownloadLink(
  gameId: GameId,
  modId: string,
  fileId: string,
  apiKey: string,
  nxm?: { key: string; expires: string },
): Promise<string> {
  const domain = NEXUS_DOMAINS[gameId];
  if (!domain) throw new Error('No Nexus domain for this game.');

  const query = nxm ? `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(nxm.expires)}` : '';
  try {
    const links = await getJson<Array<{ URI: string }>>(
      `${API}/games/${domain}/mods/${modId}/files/${fileId}/download_link.json${query}`,
      headers(apiKey),
    );
    const uri = links[0]?.URI;
    if (!uri) throw new Error('Nexus returned no download URL.');
    return uri;
  } catch (err) {
    if (err instanceof NetworkError && err.status === 403) {
      throw new NexusAuthError(
        'Direct API downloads need Nexus Premium. Open the mod page and use its "Mod Manager Download" button — Swapmeet will catch the file.',
      );
    }
    throw err;
  }
}

/** Parse an `nxm://` URL handed over by the browser's download button. */
export function parseNxmUrl(url: string): {
  domain: string;
  modId: string;
  fileId: string;
  key?: string;
  expires?: string;
} | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'nxm:') return null;
    // nxm://<domain>/mods/<modId>/files/<fileId>?key=...&expires=...
    const segments = parsed.pathname.split('/').filter(Boolean);
    const modId = segments[1];
    const fileId = segments[3];
    if (!modId || !fileId) return null;
    const result: ReturnType<typeof parseNxmUrl> = {
      domain: parsed.hostname,
      modId,
      fileId,
    };
    const key = parsed.searchParams.get('key');
    const expires = parsed.searchParams.get('expires');
    if (key) result.key = key;
    if (expires) result.expires = expires;
    return result;
  } catch {
    return null;
  }
}

/** The GameId matching a Nexus domain, for routing an nxm:// handoff. */
export function gameIdForDomain(domain: string): GameId | null {
  const entry = Object.entries(NEXUS_DOMAINS).find(
    ([, d]) => d?.toLowerCase() === domain.toLowerCase(),
  );
  return (entry?.[0] as GameId) ?? null;
}
