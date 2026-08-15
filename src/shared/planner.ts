/**
 * Load order, conflicts and the swap preview.
 *
 * Everything in this file is a pure function over plain data. That is
 * deliberate: the rules that decide which mod wins a contested file are the
 * part of a mod manager users get burned by, so they should be testable
 * without a game install, a filesystem or an Electron window.
 *
 * The governing rule is the one every mod manager settles on eventually:
 * **later in the load order wins**. A mod's position is its priority.
 */

import { deployRootFor, getGame } from './games';
import type {
  Conflict,
  DeployManifest,
  DiffEntry,
  GameId,
  Mod,
  Profile,
  SwapPlan,
} from './types';

/** Join a deploy root and a mod-relative path into a game-relative path. */
export function targetPath(mod: Mod, relFile: string): string {
  const root = deployRootFor(getGame(mod.gameId), mod.kind);
  return root ? `${root}/${relFile}` : relFile;
}

/** The mods a profile will actually deploy, in load order. */
export function activeMods(profile: Profile, mods: Mod[]): Mod[] {
  if (profile.vanillaLock) return [];
  const byId = new Map(mods.map((m) => [m.id, m]));
  const enabled = new Set(profile.enabled);
  return profile.order
    .filter((id) => enabled.has(id))
    .map((id) => byId.get(id))
    .filter((m): m is Mod => m !== undefined);
}

/**
 * Map every game-relative path to the mod that owns it under the current
 * order. Iterating in load order and letting later writes clobber earlier
 * ones is exactly the "later wins" rule, expressed directly.
 */
export function resolveFileMap(ordered: Mod[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const mod of ordered) {
    for (const file of mod.files) {
      map.set(targetPath(mod, file), mod.id);
    }
  }
  return map;
}

/**
 * Find every path claimed by more than one enabled mod.
 *
 * A conflict is not an error. Two texture packs touching the same file is
 * routine, and the load order already answers it. What the user needs is to
 * *see* the answer, so each conflict names its winner.
 */
export function findConflicts(ordered: Mod[]): Conflict[] {
  const claims = new Map<string, string[]>();
  for (const mod of ordered) {
    for (const file of mod.files) {
      const target = targetPath(mod, file);
      const list = claims.get(target);
      if (list) list.push(mod.id);
      else claims.set(target, [mod.id]);
    }
  }

  const conflicts: Conflict[] = [];
  for (const [target, modIds] of claims) {
    if (modIds.length < 2) continue;
    conflicts.push({
      target,
      modIds,
      // `ordered` is in load order, so the last claimant is the winner.
      winnerId: modIds[modIds.length - 1]!,
    });
  }
  return conflicts.sort((a, b) => a.target.localeCompare(b.target));
}

/** Group conflicts by the pair of mods involved, for a readable UI summary. */
export function conflictsByMod(conflicts: Conflict[]): Map<string, Conflict[]> {
  const out = new Map<string, Conflict[]>();
  for (const c of conflicts) {
    for (const id of c.modIds) {
      const list = out.get(id);
      if (list) list.push(c);
      else out.set(id, [c]);
    }
  }
  return out;
}

/**
 * Enabled mods whose declared requirements are not also enabled.
 * Returns `[dependent, missingId]` pairs.
 */
export function missingDependencies(ordered: Mod[]): Array<[Mod, string]> {
  const present = new Set(ordered.map((m) => m.id));
  const out: Array<[Mod, string]> = [];
  for (const mod of ordered) {
    for (const req of mod.requires) {
      if (!present.has(req)) out.push([mod, req]);
    }
  }
  return out;
}

/**
 * A mod that must load before another (a script hook, say) but sits after it
 * in the order. Core mods are pinned to the top, so anything above one is
 * misordered.
 */
export function misorderedCoreMods(ordered: Mod[]): Mod[] {
  const lastCoreIndex = ordered.reduce(
    (acc, mod, i) => (mod.core ? i : acc),
    -1,
  );
  if (lastCoreIndex < 0) return [];
  return ordered.slice(0, lastCoreIndex).filter((m) => !m.core);
}

/**
 * Sort a load order so core mods sit at the top, preserving relative order
 * within each band. Used by the "tidy order" action.
 */
export function normaliseOrder(order: string[], mods: Mod[]): string[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const core = order.filter((id) => byId.get(id)?.core);
  const rest = order.filter((id) => !byId.get(id)?.core);
  return [...core, ...rest];
}

/** Move an id within an order array, returning a new array. */
export function reorder(order: string[], modId: string, toIndex: number): string[] {
  const from = order.indexOf(modId);
  if (from === -1) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, modId);
  return next;
}

/**
 * Build the preview shown before a profile swap.
 *
 * This is the screen that makes the whole tool trustworthy: before anything
 * moves, the user sees exactly which mods leave the game folder, which
 * arrive, and which stay put. Mods common to both profiles are reported as
 * KEEP and are not touched at all, which is what keeps swaps fast.
 */
export function buildSwapPlan(args: {
  gameId: GameId;
  from: Profile | null;
  to: Profile;
  mods: Mod[];
  /** What is currently laid down, if anything. */
  manifest: DeployManifest | null;
  /** Free bytes on the game volume, when known. */
  freeBytes?: number | null;
  /** Set when the game itself is running. */
  gameRunning?: boolean;
  /** Names of the running game processes, for a precise message. */
  runningProcesses?: string[];
  /** Whether the user wants online-safety warnings. Off by default. */
  warnAboutOnline?: boolean;
}): SwapPlan {
  const { gameId, from, to, mods, manifest } = args;

  const fromMods = from ? activeMods(from, mods) : [];
  const toMods = activeMods(to, mods);

  const fromIds = new Set(fromMods.map((m) => m.id));
  const toIds = new Set(toMods.map((m) => m.id));

  const entries: DiffEntry[] = [];
  let filesIn = 0;
  let filesOut = 0;
  let filesKept = 0;
  let bytesToWrite = 0;

  for (const mod of fromMods) {
    if (toIds.has(mod.id)) continue;
    entries.push({
      kind: 'out',
      modId: mod.id,
      name: mod.name,
      path: `-> shelf/${gameId}/${from?.name ?? 'previous'}/`,
      fileCount: mod.files.length,
    });
    filesOut += mod.files.length;
  }

  for (const mod of toMods) {
    if (fromIds.has(mod.id)) {
      entries.push({
        kind: 'keep',
        modId: mod.id,
        name: mod.name,
        path: 'unchanged',
        fileCount: mod.files.length,
      });
      filesKept += mod.files.length;
      continue;
    }
    const root = deployRootFor(getGame(gameId), mod.kind);
    entries.push({
      kind: 'in',
      modId: mod.id,
      name: mod.name,
      path: root ? `-> ${root}/` : '-> game root',
      fileCount: mod.files.length,
    });
    filesIn += mod.files.length;
    bytesToWrite += mod.size;
  }

  // OUT first, then IN, then KEEP: the destructive half of the plan reads first.
  const rank = { out: 0, in: 1, keep: 2 } as const;
  entries.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));

  const conflicts = findConflicts(toMods);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (args.gameRunning) {
    const names = args.runningProcesses?.length
      ? ` (${args.runningProcesses.join(', ')})`
      : '';
    blockers.push(
      `${getGame(gameId).shortName} is running${names}. Close the game before swapping.`,
    );
  }

  for (const [mod, missing] of missingDependencies(toMods)) {
    const dep = mods.find((m) => m.id === missing);
    blockers.push(`${mod.name} needs ${dep?.name ?? missing}, which is not enabled.`);
  }

  if (args.freeBytes != null && args.freeBytes < bytesToWrite) {
    blockers.push(
      `Not enough free space: needs ${formatBytes(bytesToWrite)}, ${formatBytes(args.freeBytes)} available.`,
    );
  }

  const def = getGame(gameId);
  // Opt-in: these titles launch into a story/online chooser, so this warning
  // would otherwise fire on every single swap regardless of intent.
  if (args.warnAboutOnline && def.hasOnline && !to.vanillaLock && toMods.length > 0) {
    warnings.push(
      `${def.shortName} has an online mode. Switch to a vanilla-locked profile before playing online.`,
    );
  }

  const misordered = misorderedCoreMods(toMods);
  if (misordered.length > 0) {
    warnings.push(
      `${misordered.length} mod(s) load before a core dependency. Tidy the order to fix.`,
    );
  }

  if (conflicts.length > 0) {
    warnings.push(
      `${conflicts.length} file conflict(s). The mod lowest in the load order wins each one.`,
    );
  }

  if (manifest && manifest.profileId === to.id) {
    warnings.push('This profile is already deployed. Applying will refresh it.');
  }

  return {
    gameId,
    fromProfileId: from?.id ?? null,
    toProfileId: to.id,
    entries,
    filesIn,
    filesOut,
    filesKept,
    bytesToWrite,
    conflicts,
    blockers,
    warnings,
  };
}

/** Human-readable byte count. Kept here so main and renderer agree. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
