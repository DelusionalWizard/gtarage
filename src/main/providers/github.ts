/**
 * The Essentials provider, backed by the public GitHub Releases API.
 *
 * This is the provider that works with no account, no key and no setup, and
 * it covers the tools that everything else depends on: ASI loaders, script
 * hooks, CLEO, modloader, UE4SS. For a new install it is the only thing most
 * people need before they can use anything else.
 *
 * Two entries in the catalog have no GitHub repo because their authors
 * distribute them elsewhere (ScriptHookV, OpenIV). They are surfaced as
 * link-outs rather than given a fabricated download URL.
 */

import { ESSENTIALS, type CatalogFile, type CatalogMod, type EssentialDef } from '../../shared/catalog';
import type { GameId } from '../../shared/types';
import { getJson } from '../net';

interface GhAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  body: string | null;
  assets: GhAsset[];
}

/** Release metadata is stable for minutes at a time; don't re-fetch per keystroke. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; release: GhRelease | null }>();

/** Anything that is an installer or a bare executable. */
function isExecutable(name: string): boolean {
  return /\.(exe|msi|bat|cmd|ps1|scr)$/i.test(name);
}

/**
 * Pick the asset a normal user wants.
 *
 * Release pages routinely carry debug builds, source archives and side
 * packages alongside the real thing. Heuristics: prefer archives over
 * installers, penalise anything that announces itself as a dev/debug/source
 * build, and prefer 64-bit where both are offered.
 */
function scoreAsset(asset: { name: string }): number {
  const name = asset.name.toLowerCase();
  let score = 0;
  if (/\.(zip|7z|rar)$/i.test(name)) score += 10;
  if (isExecutable(name)) score -= 6;
  // `z?` catches the `zDEV-` naming UE4SS uses for its debug build.
  if (/(^|[^a-z])z?(dev|debug|pdb|symbols|source|src)([^a-z]|$)/.test(name)) score -= 12;
  // A leading `z` is a common "sort me last, I am an extra" convention
  // (zCustomGameConfigs, zMapGenBP) and never marks the main download.
  if (/^z/.test(name)) score -= 2;
  if (/x64|win64|64bit/.test(name)) score += 3;
  if (/x86|win32|32bit/.test(name)) score -= 1;
  return score;
}

/**
 * Fetch a release: a specific tag when the catalog names one, otherwise the
 * repo's latest.
 *
 * The tag matters for repos that publish one release per game. Widescreen
 * Fixes Pack covers a hundred-odd titles in a single repo, so `latest` is
 * whichever game its author touched most recently and has nothing to do with
 * the game the user is looking at.
 */
/**
 * Choose and rank a release's assets for one game.
 *
 * A per-game selector wins over the generic scoring, because it encodes what
 * the heuristics cannot know: which architecture the title needs, or which of
 * several bundled games an asset belongs to. Exported so this can be tested
 * without going near the network -- it is the part that has already produced
 * a wrong-game download once.
 */
export function selectAssets<T extends { name: string }>(
  def: Pick<EssentialDef, 'assetPatterns'>,
  gameId: GameId,
  assets: T[],
): T[] {
  const patternSource = def.assetPatterns?.[gameId];
  let chosen = assets;

  if (patternSource) {
    const pattern = new RegExp(patternSource, 'i');
    const matched = assets.filter((a) => pattern.test(a.name));
    // If the release layout changed upstream, fall back to everything rather
    // than showing the user nothing at all.
    if (matched.length > 0) chosen = matched;
  }

  return [...chosen].sort((a, b) => scoreAsset(b) - scoreAsset(a));
}

async function fetchLatestRelease(repo: string, tag?: string): Promise<GhRelease | null> {
  const cacheKey = tag ? `${repo}@${tag}` : repo;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.release;

  let release: GhRelease | null = null;

  if (tag) {
    try {
      release = await getJson<GhRelease>(
        `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
        { Accept: 'application/vnd.github+json' },
      );
    } catch {
      release = null;
    }
    cache.set(cacheKey, { at: Date.now(), release });
    return release;
  }

  try {
    release = await getJson<GhRelease>(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { Accept: 'application/vnd.github+json' },
    );
  } catch {
    // Some projects only ever publish prereleases, so `latest` 404s. Fall
    // back to the most recent published release of any kind.
    try {
      const all = await getJson<GhRelease[]>(
        `https://api.github.com/repos/${repo}/releases?per_page=10`,
        { Accept: 'application/vnd.github+json' },
      );
      release = all.find((r) => !r.draft) ?? null;
    } catch {
      release = null;
    }
  }

  cache.set(cacheKey, { at: Date.now(), release });
  return release;
}

/** Turn a catalog definition plus its live release into a browsable mod. */
function toCatalogMod(
  def: EssentialDef,
  release: GhRelease | null,
  gameId: GameId,
): CatalogMod {
  if (!def.repo) {
    return {
      providerId: 'essentials',
      id: def.id,
      name: def.name,
      summary: def.summary,
      author: def.author,
      version: '—',
      url: def.homepage,
      category: def.category,
      manualOnly: true,
      manualReason: def.manualReason ?? 'This tool is distributed outside any API Swapmeet can call.',
      files: [],
    };
  }

  if (!release) {
    return {
      providerId: 'essentials',
      id: def.id,
      name: def.name,
      summary: def.summary,
      author: def.author,
      version: 'unavailable',
      url: def.homepage,
      category: def.category,
      manualOnly: true,
      manualReason: 'GitHub did not return a release just now. Open the project page to download it by hand.',
      files: [],
    };
  }

  const ranked = selectAssets(def, gameId, release.assets);
  const best = ranked[0];

  const files: CatalogFile[] = ranked.map((asset) => ({
    id: String(asset.id),
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    executable: isExecutable(asset.name),
    primary: asset.id === best?.id,
  }));

  return {
    providerId: 'essentials',
    id: def.id,
    name: def.name,
    summary: def.summary,
    author: def.author,
    version: release.tag_name,
    url: release.html_url || def.homepage,
    category: def.category,
    updatedAt: release.published_at,
    files,
    ...(files.length === 0
      ? {
          manualOnly: true,
          manualReason: 'This release has no downloadable files attached. Open the project page instead.',
        }
      : {}),
  };
}

/**
 * Every essential for a game, resolved in parallel.
 *
 * One repo being unreachable must not blank the whole list, so each entry
 * degrades to a link-out on its own.
 */
export async function browseEssentials(gameId: GameId, search: string): Promise<CatalogMod[]> {
  const defs = ESSENTIALS.filter((e) => e.games.includes(gameId));

  const mods = await Promise.all(
    defs.map(async (def) =>
      toCatalogMod(
        def,
        def.repo ? await fetchLatestRelease(def.repo, def.releaseTags?.[gameId]) : null,
        gameId,
      ),
    ),
  );

  const needle = search.trim().toLowerCase();
  if (!needle) return mods;
  return mods.filter((m) =>
    `${m.name} ${m.summary} ${m.author} ${m.category}`.toLowerCase().includes(needle),
  );
}

/** Clear the release cache, so the UI's refresh button really refreshes. */
export function clearEssentialsCache(): void {
  cache.clear();
}
