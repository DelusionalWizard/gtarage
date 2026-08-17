/**
 * Electron entry point: create the window, wire the single IPC channel, and
 * get out of the way.
 */

import path from 'node:path';

import { BrowserWindow, app, ipcMain, shell } from 'electron';

import { CALL_CHANNEL, type ApiMethod } from '../shared/api';
import { handlers, initApi, modSiteHooks } from './api';
import {
  initConfig,
  libraryFor,
  loadConfig,
  migrateLegacyUserData,
  shelfFor,
  repointPaths,
  saveConfig,
} from './config';
import { GAME_ORDER } from '../shared/games';
import { detectGames } from './detect';
import { ensureVanillaProfile } from './config';
import { ensureDir } from './fsutil';
import { repairLibrary, sweepOrphanedModFolders } from './library';
import { initModSites } from './modsites';

const isDev = process.argv.includes('--dev');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    // The design draws its own title bar, so the OS one is removed.
    frame: false,
    backgroundColor: '#0d0f11',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs `require` for the ipc bridge
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/assets/index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Never let the renderer navigate away or spawn windows; external links
  // open in the user's real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  return win;
}

// A second launch must not start a rival copy that would fight over the same
// config file; it focuses the running one instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');

  // The app was renamed from Rigging, which moves userData. Bring an existing
  // library across before anything reads config, or it looks like a fresh
  // install to someone who already had mods set up.
  const migrated = await migrateLegacyUserData(
    userDataDir,
    path.join(path.dirname(userDataDir), 'rigging'),
  );
  if (migrated) console.log(`[swapmeet] migrated previous data from ${migrated}`);

  initConfig(userDataDir);


  const config = await loadConfig(userDataDir);

  // Moving the files was only half the job: the config records absolute
  // paths, so they have to be repointed too or the app keeps quietly reading
  // out of the old folder.
  // Runs whenever the legacy folder is still around, not only on the launch
  // that moved the files: an earlier partial migration can leave paths behind
  // even though the data itself has moved. A no-op when nothing matches.
  if (migrated) {
    const repointed = repointPaths(config, migrated, userDataDir);
    if (repointed > 0) {
      console.log(`[swapmeet] repointed ${repointed} stored path(s) to the new data folder`);
      await saveConfig(config);
    }
  }

  await ensureDir(config.libraryPath);
  await ensureDir(config.shelfPath);

  // Repair entries imported under rules that have since been corrected.
  const repairs = await repairLibrary(config.mods);
  if (repairs.length > 0) {
    for (const { name, change } of repairs) {
      console.log(`[swapmeet] repaired ${name}: ${change}`);
    }
    await saveConfig(config);
  }

  /*
   * Move aside library folders no mod refers to.
   *
   * Guarded on the mod list being non-empty, and that guard is the whole
   * safety property. A damaged config was already handled (readJsonStrict
   * distinguishes "corrupt" from "absent"), but an *absent* one is a first
   * run, and a first run has an empty mod list by definition. Sweeping on
   * that basis means: config lost or app freshly installed over an existing
   * library -> every folder is "unreferenced" -> the entire library is
   * quarantined. That is precisely how a real user's ChaosMod disappeared.
   *
   * Zero known mods can never justify sweeping a non-empty library. There is
   * no case where the right answer is "the config knows about nothing, so
   * remove everything".
   */
  if (config.mods.length === 0) {
    console.log('[swapmeet] no mods in the config — leaving the library untouched');
  } else {
    for (const gameId of GAME_ORDER) {
      const orphans = await sweepOrphanedModFolders(
        libraryFor(config, gameId),
        new Set(config.mods.filter((m) => m.gameId === gameId).map((m) => m.id)),
        path.join(shelfFor(config, gameId), 'quarantine'),
      );
      for (const { id, bytes, quarantined } of orphans) {
        console.log(
          quarantined
            ? `[swapmeet] quarantined unreferenced library folder ${id} (${(bytes / 1048576).toFixed(2)} MB) — recoverable from the shelf`
            : `[swapmeet] removed empty library folder ${id}`,
        );
      }
    }
  }

  // First run: find whatever is installed so the app opens with something
  // useful on screen rather than an empty shell.
  if (config.installs.length === 0) {
    for (const install of await detectGames()) {
      config.installs.push(install);
      ensureVanillaProfile(config, install.gameId);
    }
    if (config.installs[0]) config.lastGameId = config.installs[0].gameId;
    await saveConfig(config);
  }

  const win = createWindow();
  initApi(userDataDir, win);
  initModSites(modSiteHooks());


  // One channel, dispatched by method name. Anything not in `handlers` is
  // rejected rather than reflected onto some other object.
  ipcMain.handle(CALL_CHANNEL, async (_event, method: ApiMethod, args: unknown[]) => {
    const fn = Object.prototype.hasOwnProperty.call(handlers, method)
      ? (handlers[method] as (...a: unknown[]) => Promise<unknown>)
      : undefined;
    if (typeof fn !== 'function') throw new Error(`Unknown method: ${String(method)}`);
    try {
      return await fn(...(args ?? []));
    } catch (err) {
      // Surface a clean message; the stack is only useful in the main log.
      console.error(`[swapmeet] ${String(method)} failed:`, err);
      throw new Error((err as Error).message);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
