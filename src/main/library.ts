/**
 * The mod library: importing mods and working out how they want to be laid
 * down.
 *
 * GTArage never installs a mod into the game folder at import time. Files are
 * copied into a per-game library folder and indexed; deployment happens later
 * and is fully reversible. That separation is the whole reason profiles can
 * be swapped safely.
 *
 * The interesting work here is classification. Mod archives are packaged by
 * thousands of different authors with no standard between them, so the
 * importer has to look at what is inside and decide where it belongs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { GAMES, deployRootFor } from '../shared/games';
import type { GameId, Mod, ModKind } from '../shared/types';
import {
  dirSize,
  ensureDir,
  exists,
  isDirectory,
  isInside,
  toPosix,
  walk,
} from './fsutil';
import { describeOiv, oivVerdict, parseOiv } from '../shared/oiv';
import { scanDependencies } from './depscan';
import { extractArchive, isArchive } from './extract';

/** Folder names that already express a game-relative layout. */
const LAYOUT_FOLDERS = new Set([
  'scripts',
  'mods',
  'cleo',
  'modloader',
  'plugins',
  'update',
  'x64',
  'common',
  'gameface',
  'pc',
]);

/** Wrapper folders worth descending through when they are the only entry. */
function isWrapperFolder(name: string): boolean {
  return !LAYOUT_FOLDERS.has(name.toLowerCase());
}

/**
 * Documentation that sits alongside the real payload.
 *
 * These matter because of archives like ScriptHookV, which ship as a readme
 * plus a `bin/` folder holding the actual DLL. A strict "descend only when
 * the folder is alone" rule refuses to unwrap that, and every file then
 * deploys one level too deep — into `<game>/bin/`, where nothing loads them.
 * Treating loose documentation as ignorable makes the payload folder the
 * obvious single child that it really is.
 */
const DOC_FILE = /\.(txt|md|nfo|pdf|url|html?|rtf|jpg|png|gif)$/i;

/**
 * Archives are frequently wrapped in one or more redundant folders
 * (`MyMod v1.2/MyMod/...`). Descend while there is exactly one directory and
 * no files at the top, but stop the moment the folder name means something.
 */
async function unwrapRoot(dir: string): Promise<string> {
  let current = dir;
  for (let depth = 0; depth < 5; depth++) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return current;
    }
    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());
    // Loose documentation does not stop us descending; anything else does,
    // because it is part of the mod's own layout.
    const payloadFiles = files.filter((f) => !DOC_FILE.test(f.name));

    if (
      dirs.length === 1 &&
      payloadFiles.length === 0 &&
      dirs[0] &&
      isWrapperFolder(dirs[0].name)
    ) {
      current = path.join(current, dirs[0].name);
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Decide how a mod folder should be deployed.
 *
 * Order matters. The strongest signal is a top-level folder that already
 * names a game-relative destination (`scripts/`, `mods/`, `CLEO/`): that
 * means the author packaged the mod relative to the game root, so it should
 * be deployed verbatim rather than shoved under a deploy root. Only when
 * that is absent do we classify by file extension.
 */
export async function classifyMod(dir: string, gameId: GameId): Promise<ModKind> {
  const files = await walk(dir);
  return classifyFiles(
    files.map((f) => f.rel),
    gameId,
  );
}

/**
 * The classification rules themselves, over a list of game-relative paths.
 *
 * Split out from `classifyMod` so an existing library entry can be
 * re-classified from its stored file list, with no disk access. That is what
 * lets a shipped misclassification be repaired at startup instead of
 * requiring every mod to be re-imported.
 */
export function classifyFiles(fileList: string[], gameId: GameId): ModKind {
  const def = GAMES[gameId];
  const supported = new Set<ModKind>(def.supportedKinds);
  const names = fileList.map((f) => toPosix(f).toLowerCase());
  const topLevel = new Set(
    names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')),
  );

  const has = (pattern: RegExp) => names.some((n) => pattern.test(n));

  // An OpenIV package identifies itself.
  if (supported.has('oiv') && has(/^assembly\.xml$/)) return 'oiv';

  // Author already used game-relative folders: deploy as-is from the root.
  for (const folder of ['scripts', 'mods', 'cleo', 'modloader', 'gameface', 'pc', 'update']) {
    if (topLevel.has(folder)) return 'raw';
  }

  // Unreal Engine 4 remasters.
  if (supported.has('pak') && has(/\.(pak|ucas|utoc)$/)) return 'pak';
  if (supported.has('lua') && has(/(^|\/)scripts\/main\.lua$/)) return 'lua';
  if (supported.has('lua') && has(/\.lua$/) && !has(/\.(asi|dll)$/)) return 'lua';

  /*
   * Proxy DLLs must land at the game root, never in scripts/.
   *
   * An ASI loader works by impersonating a system DLL the game already loads
   * (`dinput8.dll`, `winmm.dll`, ...) so Windows loads it at startup. Put one
   * in `scripts/` and it is simply never loaded, and every ASI plugin that
   * depends on it silently does nothing -- which is exactly what a
   * misclassified Ultimate ASI Loader produced. The `asi` kind deploys to the
   * game root, so this check has to come before the generic .dll rule.
   */
  // Names taken from Ultimate ASI Loader's own list of supported proxies.
  if (
    supported.has('asi') &&
    has(/^(dinput8|dsound|winmm|version|vorbisfile|binkw32|xlive|wininet)\.dll$/)
  ) {
    return 'asi';
  }

  // Graphics wrappers sit next to the executable and hijack a system DLL.
  if (
    supported.has('graphics') &&
    has(/^(d3d9|d3d11|d3d12|dxgi|opengl32)\.dll$/)
  ) {
    return 'graphics';
  }
  if (supported.has('graphics') && has(/^(enbseries\.ini|reshade\.ini|enblocal\.ini)$/)) {
    return 'graphics';
  }

  // Classic 3D-era script formats.
  if (supported.has('cleo') && has(/\.(cs|cm|cleo)$/)) return 'cleo';

  // ASI plugins and .NET scripts.
  if (supported.has('asi') && has(/\.asi$/)) return 'asi';
  if (supported.has('script') && has(/\.(dll|cs|vb)$/)) return 'script';

  // Loose replacement assets for the HD era belong under mods/.
  if (supported.has('replace') && has(/\.(rpf|ytd|yft|ydr|ymt|meta|xml)$/)) return 'replace';

  return 'raw';
}

/** Guess a display category from the kind and contents, for the filter chips. */
function categoryFor(kind: ModKind, files: string[]): string {
  const names = files.map((f) => f.toLowerCase());
  if (names.some((n) => /handling|vehicles?|carcols|\.yft$/.test(n))) return 'vehicles';
  if (names.some((n) => /timecycle|enbseries|reshade|\.ytd$/.test(n))) return 'graphics';
  if (names.some((n) => /\.(wav|mp3|ogg|awc)$/.test(n))) return 'audio';
  switch (kind) {
    case 'asi':
    case 'script':
    case 'cleo':
    case 'lua':
      return 'scripts';
    case 'pak':
    case 'replace':
    case 'oiv':
      return 'content';
    case 'graphics':
      return 'graphics';
    default:
      return 'other';
  }
}

/** Core mods are load-bearing: other mods stop working without them. */
const CORE_PATTERNS = [
  /scripthookv(\.dll)?$/i,
  /scripthookvdotnet/i,
  /^dinput8\.dll$/i,
  /ultimate\s*asi\s*loader/i,
  /^cleo\.asi$/i,
  /modloader\.asi$/i,
  /ue4ss/i,
];

function looksCore(name: string, files: string[]): boolean {
  return (
    CORE_PATTERNS.some((re) => re.test(name)) ||
    files.some((f) => CORE_PATTERNS.some((re) => re.test(path.basename(f))))
  );
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'mod'
  );
}

/** Pull a trailing version number out of a folder or archive name. */
function guessVersion(name: string): string {
  const m = name.match(/(?:^|[\s_v-])v?(\d+(?:\.\d+){0,3})(?:\D|$)/i);
  return m?.[1] ?? '1.0';
}

/** Strip version noise from a name for display. */
function cleanName(raw: string): string {
  return (
    raw
      .replace(/\.(zip|oiv|rar|7z)$/i, '')
      .replace(/[\s_-]*v?\d+(\.\d+){1,3}\s*$/i, '')
      .replace(/[_]+/g, ' ')
      .trim() || raw
  );
}

export interface ImportResult {
  mod: Mod;
  /** Anything the user should know: unusual layout, guessed kind, etc. */
  notes: string[];
}

/**
 * Import a folder or archive into the library for one game.
 *
 * `libraryRoot` is the per-game library directory. The mod ends up at
 * `<libraryRoot>/<id>/` with its files laid out relative to its deploy root.
 */
export async function importMod(
  sourcePath: string,
  gameId: GameId,
  libraryRoot: string,
  existingIds: Set<string>,
): Promise<ImportResult> {
  const notes: string[] = [];
  const base = path.basename(sourcePath);

  // Unique, human-readable id.
  const displayName = cleanName(base);
  const slug = slugify(displayName);
  let id = slug;
  let suffix = 2;
  // Unique against the index *and* against the disk. A folder left behind by
  // a failed import or a delete that could not finish is invisible to the
  // index, and renaming a new payload into it would silently merge two
  // unrelated mods into one folder.
  while (existingIds.has(id) || (await exists(path.join(libraryRoot, id)))) {
    id = `${slug}-${suffix++}`;
  }

  const destDir = path.join(libraryRoot, id);
  await ensureDir(destDir);

  // Everything from here on happens inside one try. A failure part-way used
  // to escape with the mod folder already populated but never recorded in the
  // config, leaving an orphan the next import could silently merge into.
  let contentDir: string;
  let kind: ModKind;
  let files: string[];
  try {
    // Stage the payload: extract archives, copy folders.
    const staging = path.join(destDir, '.staging');
    await ensureDir(staging);
    if (await isDirectory(sourcePath)) {
      await fs.cp(sourcePath, staging, { recursive: true });
    } else if (isArchive(base)) {
      await extractArchive(sourcePath, staging);
    } else {
      // A bare file, e.g. someone dragging in a single .asi or .pak.
      await fs.copyFile(sourcePath, path.join(staging, base));
    }

    // Normalise the layout, then move the real payload up into the mod folder.
    const payloadRoot = await unwrapRoot(staging);
    if (payloadRoot !== staging) {
      notes.push('Removed a redundant wrapper folder from the archive.');
    }

    contentDir = path.join(destDir, 'content');
    await ensureDir(contentDir);
    for (const entry of await fs.readdir(payloadRoot)) {
      await fs.rename(path.join(payloadRoot, entry), path.join(contentDir, entry));
    }
    await fs.rm(staging, { recursive: true, force: true });

    kind = await classifyMod(contentDir, gameId);
    const walked = await walk(contentDir);
    files = walked.map((f) => toPosix(f.rel)).sort();

    if (files.length === 0) {
      throw new Error('That archive contained no files.');
    }
  } catch (err) {
    // Do not leave a half-built mod folder behind for the next import to trip on.
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  if (kind === 'raw') {
    notes.push(
      'Layout was not recognised, so files will be deployed relative to the game root exactly as packaged.',
    );
  } else {
    const root = deployRootFor(GAMES[gameId], kind);
    notes.push(`Detected as a "${kind}" mod; deploys into ${root || 'the game root'}.`);
  }

  /*
   * An OpenIV package is a script, not a file tree.
   *
   * Copying its contents in is not installing it: most of them write inside
   * RPF archives, which GTArage cannot open. Left unsaid, the mod imports
   * cleanly, deploys cleanly and changes nothing in the game — the worst
   * failure this app has, because there is no error anywhere to follow.
   */
  if (kind === 'oiv') {
    const assembly = files.find((f) => /^assembly.xml$/i.test(toPosix(f)));
    if (assembly) {
      try {
        const xml = await fs.readFile(path.join(contentDir, assembly), 'utf8');
        notes.push(describeOiv(oivVerdict(parseOiv(xml))));
      } catch {
        notes.push(
          'This is an OpenIV package and its assembly.xml could not be read, so what it changes is unknown. Install it with OpenIV if the game does not change.',
        );
      }
    }
  }

  // Work out what this mod needs before it is ever enabled, so the user finds
  // out now rather than from a silent failure at the loading screen.
  const dependencies = await scanDependencies(contentDir, files, gameId);
  if (dependencies.length > 0) {
    notes.push(
      `Needs: ${dependencies.map((d) => d.label).join(', ')}.`,
    );
  }

  const mod: Mod = {
    id,
    gameId,
    name: displayName,
    kind,
    version: guessVersion(base),
    path: contentDir,
    files,
    size: await dirSize(contentDir),
    addedAt: new Date().toISOString(),
    category: categoryFor(kind, files),
    requires: [],
    dependencies,
    core: looksCore(displayName, files),
    source: sourcePath,
  };

  return { mod, notes };
}

/**
 * Re-classify existing library entries against the current rules.
 *
 * Classification decides the deploy root, so a rule that was wrong when a mod
 * was imported leaves that mod permanently misfiled — and misfiled quietly,
 * because nothing errors, the mod just never loads. Re-running the rules over
 * each mod's stored file list at startup repairs those entries without
 * touching the disk or asking the user to re-import anything.
 *
 * Deployed files are not moved here. The next Apply sees the changed target
 * paths and relocates them through the normal diff, backups and all.
 *
 * Returns the mods whose kind changed, so the change can be reported.
 */
export function repairClassifications(
  mods: Mod[],
): Array<{ mod: Mod; from: ModKind; to: ModKind }> {
  const changed: Array<{ mod: Mod; from: ModKind; to: ModKind }> = [];
  for (const mod of mods) {
    if (mod.files.length === 0) continue;
    const next = classifyFiles(mod.files, mod.gameId);
    if (next !== mod.kind) {
      changed.push({ mod, from: mod.kind, to: next });
      mod.kind = next;
    }
  }
  return changed;
}

/**
 * Bring every library entry up to date with the current import rules.
 *
 * Run at startup. Both halves fix mistakes that are silent by construction —
 * a mod filed under the wrong kind, or with its payload one folder too deep,
 * deploys without error and simply never loads — so they are repaired
 * automatically rather than waiting for the user to suspect something and
 * press a button.
 *
 * Only the library is touched. Files already deployed are relocated by the
 * normal diff on the next Apply, with backups intact.
 */
export async function repairLibrary(
  mods: Mod[],
): Promise<Array<{ name: string; change: string }>> {
  const changes: Array<{ name: string; change: string }> = [];

  for (const mod of mods) {
    try {
      if (await repairLayout(mod)) {
        const refreshed = await refreshMod(mod);
        mod.files = refreshed.files;
        mod.size = refreshed.size;
        changes.push({ name: mod.name, change: 'unwrapped a redundant folder' });
      }
    } catch {
      // A repair that cannot run is not worth failing startup over.
    }
  }

  for (const { mod, from, to } of repairClassifications(mods)) {
    changes.push({ name: mod.name, change: `re-filed from "${from}" to "${to}"` });
  }

  return changes;
}

/**
 * The folder holding a mod, derived from the library root rather than from
 * the stored path.
 *
 * `path.dirname(mod.path)` happens to give the right answer today, but it is
 * a recursive-delete target computed by climbing one level from a value that
 * has already changed shape once. If `mod.path` were ever stored as the mod
 * root instead of its `content/` folder, that climb would land on the
 * library root for the whole game and take every other mod with it.
 *
 * So the root is composed from `<libraryRoot>/<id>` and then checked to be
 * inside the library before anything is deleted.
 */
export function modRootFor(libraryRoot: string, mod: Mod): string {
  const root = path.resolve(libraryRoot, mod.id);
  if (!isInside(libraryRoot, root)) {
    throw new Error(`Refusing to touch a path outside the library: ${root}`);
  }
  return root;
}

/**
 * Mods whose library files have gone missing.
 *
 * The index and the disk can drift: antivirus quarantines a file, a sync
 * client reclaims a folder, an import dies half-way. Checking the mod's own
 * folder is cheap, and knowing about it before a deploy is far better than
 * finding out one ENOENT at a time.
 */
export async function findBrokenMods(
  libraryRootFor: (mod: Mod) => string,
  mods: Mod[],
): Promise<Array<{ mod: Mod; missing: number }>> {
  const broken: Array<{ mod: Mod; missing: number }> = [];

  for (const mod of mods) {
    // An empty file list is odd but not broken; nothing to check.
    if (mod.files.length === 0) continue;

    if (!(await exists(mod.path))) {
      broken.push({ mod, missing: mod.files.length });
      continue;
    }

    // Sample rather than stat every file: a texture pack can hold thousands,
    // and a folder that has lost some files has almost always lost all of
    // them (the whole folder went). The deploy does the exhaustive check.
    let missing = 0;
    for (const rel of mod.files.slice(0, 12)) {
      if (!(await exists(path.join(mod.path, rel)))) missing += 1;
    }
    if (missing > 0) broken.push({ mod, missing });
  }

  return broken;
}

/** Remove a mod's files from the library. */
export async function deleteModFiles(libraryRoot: string, mod: Mod): Promise<void> {
  await fs.rm(modRootFor(libraryRoot, mod), { recursive: true, force: true });
}

/**
 * Delete library folders that no mod refers to.
 *
 * Two things leave these behind: an import that fails partway (its folder,
 * sometimes with a half-extracted `.staging` inside), and a removal that does
 * not complete because a file was locked. Neither is visible in the UI, so
 * they accumulate silently — one such leftover here was 44 MB.
 *
 * Deliberately narrow: it only ever considers directories sitting directly
 * inside `library/<gameId>/`, and only deletes one whose name is not a known
 * mod id. It is never called unless the config loaded successfully, so a
 * damaged config cannot present an empty mod list and wipe the library.
 */
export async function sweepOrphanedModFolders(
  libraryRoot: string,
  knownIds: Set<string>,
  quarantineRoot?: string,
): Promise<Array<{ id: string; bytes: number; quarantined: boolean }>> {
  let entries;
  try {
    entries = await fs.readdir(libraryRoot, { withFileTypes: true });
  } catch {
    return []; // no library folder for this game yet
  }

  const removed: Array<{ id: string; bytes: number; quarantined: boolean }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || knownIds.has(entry.name)) continue;

    const dir = path.resolve(libraryRoot, entry.name);
    if (!isInside(libraryRoot, dir)) continue; // paranoia; readdir cannot escape

    let bytes = 0;
    try {
      bytes = await dirSize(dir);
    } catch {
      // size is only for the log
    }

    /*
     * A folder holding real mod files is moved aside, not deleted.
     *
     * "Not referenced by the config" is not the same as "worthless". If the
     * app is killed between writing a mod's files and saving the config — or
     * a config write is lost — a perfectly good mod looks like an orphan.
     * Deleting on that basis destroyed 15 MB of somebody's ChaosMod, and the
     * only clue was a line in a log.
     *
     * So: an empty shell (a failed import that never got as far as writing
     * `content/`) is deleted, and anything with actual files is quarantined
     * where it can be recovered.
     */
    const hasContent = await exists(path.join(dir, 'content'));
    const worthKeeping = hasContent && bytes > 0;

    try {
      if (worthKeeping && quarantineRoot) {
        const dest = path.join(quarantineRoot, entry.name);
        await ensureDir(quarantineRoot);
        // Never clobber an earlier quarantine of the same name.
        const final = (await exists(dest)) ? `${dest}-${Date.now().toString(36)}` : dest;
        await fs.rename(dir, final).catch(async () => {
          await fs.cp(dir, final, { recursive: true });
          await fs.rm(dir, { recursive: true, force: true });
        });
        removed.push({ id: entry.name, bytes, quarantined: true });
      } else {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push({ id: entry.name, bytes, quarantined: false });
      }
    } catch {
      // Locked file: leave it, try again next launch.
    }
  }
  return removed;
}

/**
 * Hoist a library entry whose payload sits one level too deep.
 *
 * Applies the current unwrap rules to a mod that was imported under older
 * ones, moving files inside the library only. Returns true when something
 * moved. The deployment diff handles relocating anything already laid down on
 * the next Apply.
 */
export async function repairLayout(mod: Mod): Promise<boolean> {
  const root = await unwrapRoot(mod.path);
  if (root === mod.path) return false;

  // Move the payload up, then drop what is left (loose documentation).
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const entry of await fs.readdir(root)) {
    const from = path.join(root, entry);
    const to = path.join(mod.path, entry);
    if (await exists(to)) {
      // Never clobber: something of that name is already at the destination.
      skipped.push(entry);
      continue;
    }
    await fs.rename(from, to);
    moved.push(entry);
  }
  if (moved.length === 0) return false;

  // Remove the now-empty wrapper chain -- but only when nothing was left
  // behind in it. A recursive delete here used to run even when an entry had
  // been skipped just above, so the copy we deliberately refused to clobber
  // was destroyed instead of preserved. The library is the only copy of an
  // imported mod, so that was unrecoverable data loss, at startup, silently.
  if (skipped.length > 0) return true;

  const firstSegment = path.relative(mod.path, root).split(path.sep)[0];
  if (firstSegment) {
    const wrapper = path.join(mod.path, firstSegment);
    // Only prune directories that are genuinely empty now.
    await pruneEmptyTree(wrapper);
  }
  return true;
}

/**
 * Recursively remove a directory, but only the parts of it that hold no
 * files. Anything still containing real content is left exactly as it is.
 */
async function pruneEmptyTree(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyTree(path.join(dir, entry.name));
  }
  try {
    // rmdir refuses a non-empty directory, which is precisely the guard we want.
    await fs.rmdir(dir);
  } catch {
    // Still has content: leave it alone rather than destroying the user's files.
  }
}

/** Re-scan a mod's folder, picking up files added or removed by hand. */
export async function refreshMod(mod: Mod): Promise<Mod> {
  const walked = await walk(mod.path);
  return {
    ...mod,
    files: walked.map((f) => toPosix(f.rel)).sort(),
    size: walked.reduce((sum, f) => sum + f.size, 0),
  };
}
