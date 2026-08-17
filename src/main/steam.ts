/**
 * Reading and writing Steam's per-user launch options.
 *
 * This exists for one button — turning off BattlEye for GTA V Enhanced — but
 * it is the riskiest small feature in the app, because the file it edits is
 * Steam's own configuration for every game the user owns. Three rules follow
 * from that, and none of them are optional:
 *
 * 1. **Steam must not be running.** It holds `localconfig.vdf` in memory and
 *    rewrites the whole file on exit, so an edit made while it is open is
 *    silently reverted. The user then reasonably concludes the button is
 *    broken. We refuse rather than write something that will be undone.
 * 2. **Back up before writing.** A timestamped copy goes next to the original.
 * 3. **Parse, edit, re-serialise.** Never a textual substitution — see
 *    `src/shared/vdf.ts` for why.
 *
 * What this does *not* do is guarantee the flag works. `-nobattleye` is the
 * documented way to start Enhanced without the anti-cheat, but it is
 * Rockstar's flag and they can retire it. The UI says what was written rather
 * than promising an outcome.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseVdf, stringifyVdf, vdfEnsure, vdfGet } from '../shared/vdf';
import { steamRoot } from './detect';
import { exists } from './fsutil';

const execFileAsync = promisify(execFile);

/** The launch option that starts GTA V Enhanced without BattlEye. */
export const NO_BATTLEYE = '-nobattleye';

/** Where launch options live inside `localconfig.vdf`. */
const APPS_PATH = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'];

export interface LaunchOptionTarget {
  /** Absolute path of the `localconfig.vdf` this account uses. */
  file: string;
  /** Steam's numeric account id, only used for reporting. */
  accountId: string;
  /** The launch options currently set for the app, '' when none. */
  current: string;
}

export async function isSteamRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('tasklist', [
      '/fi', 'IMAGENAME eq steam.exe', '/fo', 'csv', '/nh',
    ]);
    return /"steam\.exe"/i.test(stdout);
  } catch {
    // Not being able to tell is not a reason to charge ahead at a file Steam
    // may be holding open.
    return true;
  }
}

/**
 * Every Steam account on this machine that could hold launch options.
 *
 * Steam stores them per account, and a machine with two accounts has two
 * files. Writing to only the first would appear to work and then do nothing
 * for the person actually logged in, so all of them are returned and the
 * caller writes to each.
 */
export async function launchOptionTargets(appId: number): Promise<LaunchOptionTarget[]> {
  const root = await steamRoot();
  if (!root) return [];

  const userdata = path.join(root, 'userdata');
  let accounts: string[];
  try {
    accounts = (await fs.readdir(userdata, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== '0')
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: LaunchOptionTarget[] = [];
  for (const accountId of accounts) {
    const file = path.join(userdata, accountId, 'config', 'localconfig.vdf');
    if (!(await exists(file))) continue;
    let current = '';
    try {
      const root_ = parseVdf(await fs.readFile(file, 'utf8'));
      const value = vdfGet(root_, [...APPS_PATH, String(appId), 'LaunchOptions']);
      if (typeof value === 'string') current = value;
    } catch {
      // A file we cannot parse is one we must not rewrite. Reported as a
      // target with no current value so the caller can still explain itself,
      // but `setLaunchOption` will refuse it for the same reason.
    }
    out.push({ file, accountId, current });
  }
  return out;
}

/** Add a flag to a launch-option string, leaving anything else in place. */
export function withFlag(current: string, flag: string): string {
  const parts = current.split(/\s+/).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === flag.toLowerCase())) return parts.join(' ');
  parts.push(flag);
  return parts.join(' ');
}

/** Remove a flag, leaving anything the user set themselves untouched. */
export function withoutFlag(current: string, flag: string): string {
  return current
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => p.toLowerCase() !== flag.toLowerCase())
    .join(' ');
}

export function hasFlag(current: string, flag: string): boolean {
  return current
    .split(/\s+/)
    .filter(Boolean)
    .some((p) => p.toLowerCase() === flag.toLowerCase());
}

export interface LaunchOptionResult {
  /** Files actually rewritten. */
  written: string[];
  /** The value now stored. */
  value: string;
}

/**
 * Set (or clear) one flag in the launch options for an app, for every account.
 *
 * Throws rather than half-writing: Steam running, no Steam install, or no
 * account files are all conditions the user can act on, and a silent no-op
 * here is indistinguishable from the flag not working.
 */
export async function setLaunchFlag(
  appId: number,
  flag: string,
  enabled: boolean,
): Promise<LaunchOptionResult> {
  if (await isSteamRunning()) {
    throw new Error(
      'Steam is running. It rewrites its own settings when it closes, so this change would be undone — close Steam completely and try again.',
    );
  }

  const targets = await launchOptionTargets(appId);
  if (targets.length === 0) {
    throw new Error(
      'Could not find a Steam account folder to write to. If this copy did not come from Steam, set the launch option in whichever launcher you use.',
    );
  }

  const written: string[] = [];
  let value = '';

  for (const target of targets) {
    const text = await fs.readFile(target.file, 'utf8');
    const root = parseVdf(text);

    const app = vdfEnsure(root, [...APPS_PATH, String(appId)]);
    const current = typeof app.LaunchOptions === 'string' ? app.LaunchOptions : '';
    const next = enabled ? withFlag(current, flag) : withoutFlag(current, flag);
    if (next === current) {
      value = next;
      continue;
    }

    // Steam's own key casing varies; reuse whatever this file already has so
    // the edit does not leave two keys differing only in case.
    const key =
      Object.keys(app).find((k) => k.toLowerCase() === 'launchoptions') ?? 'LaunchOptions';
    app[key] = next;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(target.file, `${target.file}.gtarage-backup-${stamp}`);
    await fs.writeFile(target.file, stringifyVdf(root), 'utf8');

    written.push(target.file);
    value = next;
  }

  return { written, value };
}

/** Whether the flag is already set for any account on this machine. */
export async function launchFlagState(
  appId: number,
  flag: string,
): Promise<{ enabled: boolean; known: boolean }> {
  const targets = await launchOptionTargets(appId);
  if (targets.length === 0) return { enabled: false, known: false };
  return { enabled: targets.some((t) => hasFlag(t.current, flag)), known: true };
}
