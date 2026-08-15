/**
 * Electron entry point: create the window, wire the single IPC channel, and
 * get out of the way.
 */

import path from 'node:path';

import { BrowserWindow, app, ipcMain, shell } from 'electron';

import { CALL_CHANNEL, type ApiMethod } from '../shared/api';
import { handlers, initApi, modSiteHooks, primeNexus } from './api';
import {
  initConfig,
  libraryFor,
  loadConfig,
  migrateLegacyUserData,
  saveConfig,
} from './config';
import { GAME_ORDER } from '../shared/games';
import { detectGames } from './detect';
import { ensureVanillaProfile } from './config';
import { ensureDir } from './fsutil';
import { repairLibrary, sweepOrphanedModFolders } from './library';
import { initModSites } from './modsites';
import { gameIdForDomain, parseNxmUrl } from './providers/nexus';

const isDev = process.argv.includes('--dev');

/**
 * Nexus's "Mod Manager Download" button hands over an `nxm://` URL. Claiming
 * the protocol is what lets a browser download become a Swapmeet import.
 *
 * On Windows the URL arrives as an argv entry on a *second* instance, so a
 * single-instance lock is required for this to work at all.
 */
function handleNxmUrl(url: string): void {
  const parsed = parseNxmUrl(url);
  if (!parsed) return;
  const gameId = gameIdForDomain(parsed.domain);
  if (!gameId) return;
  // Surfaced to the renderer; the user confirms before anything downloads.
  BrowserWindow.getAllWindows()[0]?.webContents.send('swapmeet:nxm', {
    gameId,
    modId: parsed.modId,
    fileId: parsed.fileId,
    key: parsed.key,
    expires: parsed.expires,
  });
}

function nxmUrlFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith('nxm://'));
}

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

// A second launch (including one triggered by an nxm:// link) must hand its
// URL to the running instance rather than starting a rival copy that would
// fight over the same config file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = nxmUrlFromArgv(argv);
    if (url) handleNxmUrl(url);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // macOS delivers protocol URLs through an event instead of argv.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleNxmUrl(url);
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

  app.setAsDefaultProtocolClient('nxm');

  const config = await loadConfig(userDataDir);
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

  // Delete library folders no mod refers to. Only runs once the config has
  // loaded successfully, so a damaged config can never present an empty mod
  // list and take the library with it.
  for (const gameId of GAME_ORDER) {
    const orphans = await sweepOrphanedModFolders(
      libraryFor(config, gameId),
      new Set(config.mods.filter((m) => m.gameId === gameId).map((m) => m.id)),
    );
    for (const { id, bytes } of orphans) {
      console.log(
        `[swapmeet] removed orphaned library folder ${id} (${(bytes / 1048576).toFixed(2)} MB)`,
      );
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
  void primeNexus();

  // A protocol URL can also be present on the very first launch.
  const initialNxm = nxmUrlFromArgv(process.argv);
  if (initialNxm) win.webContents.once('did-finish-load', () => handleNxmUrl(initialNxm));

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
