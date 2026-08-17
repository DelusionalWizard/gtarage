/**
 * Game build tracking - the "why did all my mods stop working" problem.
 *
 * Rockstar patches GTA V several times a year. Each patch moves the internal
 * memory addresses that Script Hook V hooks into, so every ASI plugin and
 * every .NET script stops loading until Script Hook V ships a matching build.
 * Nothing is broken, nothing is corrupt, and the game gives no useful signal -
 * mods simply do not load, and the usual next step is to start uninstalling
 * things at random.
 *
 * The whole feature rests on one observation: the game executable's file
 * version is already read at detection time, so noticing the change costs a
 * comparison. Everything here is pure so it can be tested against real version
 * strings rather than tidy invented ones.
 */

import type { GameId, SeenBuilds } from './types';

/**
 * The comparable part of a GTA version string.
 *
 * Rockstar's own versioning puts the meaningful build in the last two
 * components and leaves `1.0` fixed forever: Legacy reports `1.0.3889.0` and
 * Enhanced reports `1.0.1158.13`. Script Hook V names those same two builds in
 * its filename, so this is the form the two can be compared in.
 */
export function buildOf(version: string | undefined): string | null {
  if (!version) return null;
  const parts = version.trim().split(/[.,]/).map((p) => p.trim());
  if (parts.length < 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  // Drop the leading `1.0`, which never moves, and keep the rest.
  return parts.slice(2).join('.');
}

/**
 * Which builds a Script Hook V copy declares support for.
 *
 * The distribution is named for the builds it targets - `ScriptHookV_3889.0_
 * 1158.13.zip` covers Legacy 3889.0 and Enhanced 1158.13 in one archive. That
 * filename is the only machine-readable statement of compatibility the project
 * publishes; there is no manifest and the DLL's own file version tracks Script
 * Hook V's release number, not the game's.
 *
 * Returns an empty array when the name carries no build information, which is
 * a different thing from "supports nothing" - see `hookVerdict`.
 */
export function hookBuilds(name: string): string[] {
  const stem = name.replace(/\.(zip|rar|7z|dll)$/i, '');
  // Two or more dot-separated numbers, so a bare `3889` or a year is ignored.
  const found = stem.match(/\d+\.\d+(?:\.\d+)*/g) ?? [];
  return found.filter((b) => {
    // `1.0.3889.0` written out in full: normalise to the comparable tail.
    const normalised = buildOf(b);
    return normalised !== null || /^\d+\.\d+$/.test(b);
  }).map((b) => buildOf(b) ?? b);
}

export type HookVerdict =
  /** The copy names this exact build. */
  | { state: 'match'; builds: string[] }
  /** The copy names builds, and this is not one of them. */
  | { state: 'mismatch'; builds: string[] }
  /** Nothing in the name says which build it targets. */
  | { state: 'unknown'; builds: string[] };

/**
 * Compare an installed Script Hook V against the game build in front of it.
 *
 * `unknown` is a real and common answer - people rename downloads, and a copy
 * adopted out of a game folder is just `ScriptHookV.dll` with no version in
 * the name at all. Saying so is the honest result; guessing `mismatch` would
 * cry wolf on a working setup, and guessing `match` would defeat the point.
 */
export function hookVerdict(hookName: string, gameVersion: string | undefined): HookVerdict {
  const builds = hookBuilds(hookName);
  const target = buildOf(gameVersion);
  if (builds.length === 0 || target === null) return { state: 'unknown', builds };
  return builds.includes(target)
    ? { state: 'match', builds }
    : { state: 'mismatch', builds };
}

export type { SeenBuilds };

export interface BuildChange {
  gameId: GameId;
  /** The build recorded on a previous run. */
  previous: string;
  /** The build the executable reports now. */
  current: string;
}

/**
 * Compare the versions detected now against the ones recorded last run.
 *
 * A game with no recorded build is not a change: that is a first sighting, and
 * announcing "the game updated" the first time someone points GTArage at an
 * install would be both wrong and alarming.
 */
export function changedBuilds(
  seen: SeenBuilds,
  installs: { gameId: GameId; version?: string }[],
): BuildChange[] {
  const out: BuildChange[] = [];
  for (const install of installs) {
    const current = install.version?.trim();
    if (!current) continue;
    const previous = seen[install.gameId];
    if (!previous || previous === current) continue;
    out.push({ gameId: install.gameId, previous, current });
  }
  return out;
}

/**
 * Record what we saw, so the next run has something to compare against.
 *
 * Returns a new object rather than mutating: this goes straight into the
 * config, which is written through a serialised promise chain.
 */
export function recordBuilds(
  seen: SeenBuilds,
  installs: { gameId: GameId; version?: string }[],
): SeenBuilds {
  const next: SeenBuilds = { ...seen };
  for (const install of installs) {
    const current = install.version?.trim();
    if (current) next[install.gameId] = current;
  }
  return next;
}

/**
 * Mod kinds that stop working when the game build moves.
 *
 * Native plugins and .NET scripts run through Script Hook V and break with it.
 * Replacement assets, graphics files and OIV packages are just data the game
 * reads - a texture pack does not care which build is loading it, so listing
 * one here would send people uninstalling things that are fine.
 */
const BUILD_SENSITIVE = new Set(['asi', 'script']);

export function isBuildSensitive(mod: { kind: string; dependencies?: { capability: string }[] }): boolean {
  if (BUILD_SENSITIVE.has(mod.kind)) return true;
  return (mod.dependencies ?? []).some(
    (d) => d.capability === 'scripthookv' || d.capability === 'asiloader' || d.capability === 'shvdn',
  );
}
