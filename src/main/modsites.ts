/**
 * The in-app mod-site browser.
 *
 * This is a genuine browser window pointed at a real mod site. The user logs
 * in themselves, on the site's own login form, and browses normally. GTArage
 * does not read the page, does not automate clicks and never sees a password.
 *
 * Its single point of involvement is `will-download`: when the site starts
 * sending a file, GTArage redirects it into a staging folder and hands it to
 * the library importer, instead of letting it land in Downloads for the user
 * to find and drag over by hand.
 *
 * Two deliberate constraints on that window:
 *
 *  - **No preload, no bridge.** It gets none of GTArage's API surface. It is
 *    a sandboxed browser tab that happens to live in our process tree, and an
 *    XSS on a mod site must not reach the filesystem.
 *  - **Popups are restricted to the same site.** Mod sites are heavily
 *    monetised and pop-unders are routine; anything off-site is refused and
 *    offered to the real browser instead.
 */

import path from 'node:path';

import {
  BrowserWindow,
  Menu,
  session,
  shell,
  type DownloadItem,
  type Session,
} from 'electron';

import type { ModSite } from '../shared/sites';
import { MOD_SITES, siteUrl } from '../shared/sites';
import type { GameId } from '../shared/types';
import { safeFileName } from './net';

/** Persisted so logins survive closing the window and restarting the app. */
const PARTITION = 'persist:modsites';

/** Files we will never hand to the importer automatically. */
const EXECUTABLE = /\.(exe|msi|bat|cmd|ps1|scr|com)$/i;

export interface DownloadCapture {
  filePath: string;
  fileName: string;
  gameId: GameId;
  siteId: string;
  bytes: number;
  /** True for installers, which are staged but never auto-imported. */
  executable: boolean;
}

export interface ModSiteHooks {
  /** Where downloads are staged. */
  stagingDir(gameId: GameId): string;
  /** Fired as a download progresses, for the main window's status line. */
  onProgress(fileName: string, received: number, total: number): void;
  /** Fired once a file has finished downloading. */
  onComplete(capture: DownloadCapture): void;
  onFailed(fileName: string, reason: string): void;
}

let hooks: ModSiteHooks | null = null;
let siteWindow: BrowserWindow | null = null;
let sessionWired = false;

/** The game a captured download should be filed under. */
let activeGameId: GameId | null = null;
let activeSiteId = '';

export function initModSites(next: ModSiteHooks): void {
  hooks = next;
}

/** Registrable-ish domain, so `www.gta5-mods.com` matches `gta5-mods.com`. */
function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  return parts.slice(-2).join('.');
}

function wireDownloads(ses: Session): void {
  if (sessionWired) return;
  sessionWired = true;

  ses.on('will-download', (_event, item: DownloadItem) => {
    if (!hooks || !activeGameId) return;

    const gameId = activeGameId;
    const siteId = activeSiteId;
    const fileName = safeFileName(item.getFilename());
    const dest = path.join(hooks.stagingDir(gameId), fileName);

    // Setting the path up front suppresses the OS save dialog entirely.
    item.setSavePath(dest);

    item.on('updated', (_e, downloadState) => {
      if (downloadState === 'progressing' && !item.isPaused()) {
        hooks?.onProgress(fileName, item.getReceivedBytes(), item.getTotalBytes());
      }
    });

    item.once('done', (_e, doneState) => {
      if (doneState !== 'completed') {
        hooks?.onFailed(fileName, doneState === 'cancelled' ? 'cancelled' : 'interrupted');
        return;
      }
      hooks?.onComplete({
        filePath: dest,
        fileName,
        gameId,
        siteId,
        bytes: item.getTotalBytes(),
        executable: EXECUTABLE.test(fileName),
      });
    });
  });
}

/** A small navigation menu, since this window has no browser chrome of its own. */
function buildMenu(win: BrowserWindow, homeUrl: string): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (win.webContents.canGoBack()) win.webContents.goBack();
          },
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (win.webContents.canGoForward()) win.webContents.goForward();
          },
        },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
        { type: 'separator' },
        { label: 'Home', click: () => void win.loadURL(homeUrl) },
        {
          label: 'Open this page in my browser',
          click: () => void shell.openExternal(win.webContents.getURL()),
        },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: 'Downloads',
      submenu: [
        {
          label: 'Downloads are captured into your mod library automatically',
          enabled: false,
        },
      ],
    },
  ]);
}

/**
 * Open (or focus) the mod-site browser at a site's page for a game.
 *
 * One window is reused across sites: mod hunting is a browsing session, not a
 * pile of windows.
 */
export function openModSite(siteId: string, gameId: GameId): void {
  const site = MOD_SITES.find((s) => s.id === siteId);
  if (!site) throw new Error(`Unknown mod site: ${siteId}`);

  activeGameId = gameId;
  activeSiteId = siteId;

  const url = siteUrl(site, gameId);
  const ses = session.fromPartition(PARTITION);
  wireDownloads(ses);

  if (siteWindow && !siteWindow.isDestroyed()) {
    siteWindow.setMenu(buildMenu(siteWindow, url));
    void siteWindow.loadURL(url);
    siteWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: `${site.name} — browsing for ${gameId}`,
    backgroundColor: '#0d0f11',
    autoHideMenuBar: false,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deliberately no preload: this window gets none of GTArage's API.
      webviewTag: false,
    },
  });

  siteWindow = win;
  win.setMenu(buildMenu(win, url));

  // Ad pop-unders are endemic on these sites. Same-site popups are allowed
  // because some download flows use them; everything else goes to the real
  // browser, where the user's own ad blocking applies.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const here = baseDomain(new URL(win.webContents.getURL()).hostname);
      const there = baseDomain(new URL(target).hostname);
      if (here === there) {
        void win.loadURL(target);
        return { action: 'deny' };
      }
    } catch {
      // fall through
    }
    return { action: 'deny' };
  });

  win.on('closed', () => {
    siteWindow = null;
  });

  void win.loadURL(url);
}

export function closeModSite(): void {
  if (siteWindow && !siteWindow.isDestroyed()) siteWindow.close();
}

/** Sites usable for a game, for the UI. */
export function listSites(gameId: GameId): ModSite[] {
  return MOD_SITES.filter((s) => s.games.includes(gameId));
}
