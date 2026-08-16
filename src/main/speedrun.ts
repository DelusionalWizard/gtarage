/**
 * Finding and starting the speedrunning tools.
 *
 * Detection only looks in the handful of places installers actually use, and
 * launching is a plain `execFile` of something the user already has. Swapmeet
 * never downloads or installs any of these: most are installers, and quietly
 * fetching and running executables is precisely the behaviour a mod manager
 * should not have.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import { SPEEDRUN_TOOLS, type SpeedrunTool } from '../shared/speedrun';
import type { GameId } from '../shared/types';
import { exists } from './fsutil';

export interface DetectedTool {
  id: string;
  name: string;
  summary: string;
  url: string;
  core: boolean;
  /** Absolute path, when it is installed. */
  path?: string;
  installed: boolean;
}

/** Probe a tool's usual install locations. */
async function locate(tool: SpeedrunTool): Promise<string | null> {
  for (const candidate of tool.candidates) {
    if (await exists(candidate)) return path.normalize(candidate);
  }
  return null;
}

/**
 * Every speedrun tool relevant to a game, with whether it is installed.
 *
 * A path the user pointed us at wins over probing, since a portable tool can
 * live anywhere and they know where they put it.
 */
export async function detectSpeedrunTools(
  gameId: GameId,
  userPaths: Record<string, string> = {},
): Promise<DetectedTool[]> {
  const out: DetectedTool[] = [];

  for (const tool of SPEEDRUN_TOOLS) {
    if (!tool.games.includes(gameId)) continue;
    const chosen = userPaths[tool.id];
    const found = chosen && (await exists(chosen)) ? chosen : await locate(tool);
    const entry: DetectedTool = {
      id: tool.id,
      name: tool.name,
      summary: tool.summary,
      url: tool.url,
      core: Boolean(tool.core),
      installed: found !== null,
    };
    if (found) entry.path = found;
    out.push(entry);
  }

  // Installed first, then the load-bearing ones, so the list reads as "what
  // you have" before "what you could add".
  return out.sort(
    (a, b) =>
      Number(b.installed) - Number(a.installed) ||
      Number(b.core) - Number(a.core) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Start a detected tool.
 *
 * Detached and unreferenced, so closing Swapmeet does not take the timer or
 * the capture software down with it — which would be a genuinely bad surprise
 * mid-run.
 */
export async function launchSpeedrunTool(
  toolId: string,
  gameId: GameId,
  userPaths: Record<string, string> = {},
): Promise<void> {
  const tools = await detectSpeedrunTools(gameId, userPaths);
  const tool = tools.find((t) => t.id === toolId);

  if (!tool) throw new Error('That tool is not one Swapmeet knows about.');
  if (!tool.path) {
    throw new Error(
      `${tool.name} is not installed, or is somewhere Swapmeet does not look. Install it, or start it yourself.`,
    );
  }

  const child = execFile(tool.path, { cwd: path.dirname(tool.path) });
  child.unref();
}

/** True when Project 127 is present, which is what the Classic category uses. */
export async function hasProject127(): Promise<boolean> {
  const p127 = SPEEDRUN_TOOLS.find((t) => t.id === 'project127');
  return p127 ? (await locate(p127)) !== null : false;
}
