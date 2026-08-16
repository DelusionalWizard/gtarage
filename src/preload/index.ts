/**
 * The preload bridge.
 *
 * The renderer runs with `contextIsolation: true` and no Node integration, so
 * this is the only path from UI code to the filesystem. It exposes a plain
 * object of async methods and nothing else -- no `ipcRenderer`, no `require`,
 * no ability to name a channel the main process did not intend to serve.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  CALL_CHANNEL,
  PROGRESS_CHANNEL,
  SITE_CHANNEL,
  type ApiMethod,
  type ProgressEvent,
  type SwapmeetApi,
  type SiteEvent,
} from '../shared/api';

/** Every method name the bridge will forward. Anything else is ignored. */
const METHODS: ApiMethod[] = [
  'getState',
  'selectGame',
  'detectGames',
  'browseForGame',
  'forgetGame',
  'importMods',
  'importPaths',
  'removeMod',
  'updateMod',
  'toggleMod',
  'moveMod',
  'tidyOrder',
  'createProfile',
  'renameProfile',
  'deleteProfile',
  'setActiveProfile',
  'planSwap',
  'applyProfile',
  'undeployAll',
  'verify',
  'scanAdoptable',
  'adopt',
  'checkForUpdate',
  'installUpdate',
  'speedrunTools',
  'speedrunResources',
  'launchSpeedrunTool',
  'locateSpeedrunTool',
  'hookStatus',
  'installHook',
  'graphicsFor',
  'captureGraphics',
  'clearGraphics',
  'listSaves',
  'backupSaves',
  'restoreSave',
  'launchGame',
  'openPath',
  'updateSettings',
  'browse',
  'catalogFiles',
  'installCatalogFile',
  'refreshCatalog',
  'installDependency',
  'rescanDependencies',
  'listSites',
  'openSite',
  'openExternal',
  'setNexusKey',
  'clearNexusKey',
  'windowMinimize',
  'windowMaximize',
  'windowClose',
];

const api = Object.fromEntries(
  METHODS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(CALL_CHANNEL, method, args),
  ]),
) as unknown as SwapmeetApi;

contextBridge.exposeInMainWorld('swapmeet', api);

/**
 * Resolving a dropped file to a real path.
 *
 * Electron 32 removed the `File.path` property that every drag-and-drop
 * handler used to rely on; reading it now yields `undefined`, so a drop
 * silently does nothing. `webUtils.getPathForFile` is the replacement, and it
 * only exists in the preload, which is why this crosses the bridge.
 */
contextBridge.exposeInMainWorld('swapmeetFiles', {
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

contextBridge.exposeInMainWorld('swapmeetEvents', {
  onProgress(handler: (event: ProgressEvent) => void): () => void {
    const listener = (_e: unknown, payload: ProgressEvent) => handler(payload);
    ipcRenderer.on(PROGRESS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PROGRESS_CHANNEL, listener);
  },
  /** Downloads captured by the embedded mod-site browser. */
  onSiteEvent(handler: (event: SiteEvent) => void): () => void {
    const listener = (_e: unknown, payload: SiteEvent) => handler(payload);
    ipcRenderer.on(SITE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SITE_CHANNEL, listener);
  },
});
