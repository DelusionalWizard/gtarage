/**
 * Ambient types for the renderer.
 *
 * The renderer is loaded as a classic <script>, not a module: Chromium
 * refuses ES module scripts from `file://`, and bundling one file would be
 * silly. A classic script means `src/renderer/index.ts` must contain no
 * top-level `import` at all, or TypeScript would emit a CommonJS wrapper that
 * fails the moment `exports` is touched in a browser.
 *
 * Inline `import(...)` type syntax gives us the shared types anyway, without
 * turning either file into a module.
 */

type AppState = import('../shared/api').AppState;
type GameView = import('../shared/api').GameView;
type ProgressEvent_ = import('../shared/api').ProgressEvent;
type GTArageApi = import('../shared/api').GTArageApi;
type SaveSnapshotView = import('../shared/api').SaveSnapshotView;
type ImportReport = import('../shared/api').ImportReport;
type GraphicsView = import('../shared/api').GraphicsView;
type AdoptGroupView = import('../shared/api').AdoptGroupView;
type HookStatus = import('../shared/api').HookStatus;
type SpeedrunToolView = import('../shared/api').SpeedrunToolView;
type HookCandidateView = import('../shared/api').HookCandidateView;

type Conflict = import('../shared/types').Conflict;
type GameId = import('../shared/types').GameId;
type Mod = import('../shared/types').Mod;
type Profile = import('../shared/types').Profile;
type SwapPlan = import('../shared/types').SwapPlan;

type ModDependency = import('../shared/types').ModDependency;
type MissingDeps = import('../shared/api').MissingDeps;

interface Window {
  gtarage: GTArageApi;
  /**
   * Electron 32 removed `File.path`, so a dropped file's real location has to
   * come back through the preload.
   */
  gtarageFiles: { getPathForFile(file: File): string };
  gtarageEvents: {
    onProgress(handler: (event: ProgressEvent_) => void): () => void;
  };
}

type ResourceGroup = import('../shared/speedrun').ResourceGroup;
type SpeedrunResourceGroup = import('../shared/api').SpeedrunResourceGroup;
type UpdateView = import('../shared/api').UpdateView;
