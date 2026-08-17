# GTArage - Developer Notes

Context for anyone (human or AI) continuing this project. Read this first.

## What this project is

An open-source universal mod manager for the Grand Theft Auto games, built as
an Electron + TypeScript desktop app. It manages nine titles: GTA III, Vice
City and San Andreas (original 3D era), the three Definitive Edition
remasters, GTA IV/EFLC, and GTA V Legacy and Enhanced.

Primarily a *file manager for mods*. The **Tools** tab is where mods arrive,
by three deliberately different routes: dropping a file you already have,
the curated Essentials catalogue (resolved from GitHub Releases, the one
sanctioned API), and community sites opened in an embedded browser where the
user logs in and GTArage only captures the resulting download. It never
scrapes, and there is no search — there is no catalogue to search.

Distinct from the sibling project `../GTAV-ProfileManager`, which switches a
whole GTA V install between hard-linked folder copies. GTArage works at
per-mod granularity and covers every title.

## Stack

- Electron 33 + TypeScript 5.7, compiled with plain `tsc`. **No bundler.**
- Zero runtime dependencies. `electron`, `typescript` and `electron-builder`
  are the only devDependencies.
- Tests are `node:test`, no framework.

## Layout

```
src/shared/   types.ts, games.ts (the registry), api.ts (IPC contract),
              catalog.ts (the Essentials catalogue), sites.ts (mod sites
              and the gtamods wiki links), planner.ts (pure
              load-order/conflict/swap logic)
src/main/     index.ts (entry), api.ts (handlers), config.ts, detect.ts,
              library.ts (import+classify+repair), deploy.ts (the engine),
              depscan.ts (PE/layout dependency detection), saves.ts,
              fsutil.ts, zip.ts, extract.ts (7-Zip/WinRAR fallback),
              net.ts (ALL network access), browse.ts, modsites.ts
src/main/providers/  github.ts (Essentials)
src/preload/  index.ts - the contextBridge, the ONLY UI->fs path
src/renderer/ index.ts + assets/{index.html,styles.css}
src/test/     planner, zip, depscan, catalog, download, classify,
              deploy (end-to-end), safety
```

## Core model

- **Library** (`userData/library/<gameId>/<modId>/content/`) holds mod files.
  The game folder is untouched until a profile is applied.
- **Profile** = ordered `order[]` + `enabled[]` subset. Later in the order
  wins file conflicts. Every game gets an undeletable `vanillaLock` profile
  that deploys nothing.
- **Deploy** maps each enabled mod's files to a game-relative target via
  `deployRoots[kind]`, hard-links them into place, and records every write in
  `shelf/<gameId>/deployed.json`.
- **Shelf** (`userData/shelf/<gameId>/`) holds `deployed.json`, `displaced/`
  (game files a mod overwrote) and `saves/` (snapshots).

## Adding a game

Add one entry to `GAMES` in `src/shared/games.ts` and one id to `GAME_ORDER`.
Nothing else should need to change. The entry must define `deployRoots` for
every kind in `supportedKinds`, plus `signatureFiles` for detection.

## Critical gotchas (do not regress)

1. **The renderer must stay a classic script.** Chromium refuses ES modules
   over `file://`, and a CommonJS wrapper would break on `exports`. So
   `src/renderer/index.ts` has **no top-level imports at all** - its shared
   types come ambiently from `src/renderer/globals.d.ts` using inline
   `import(...)` type syntax. Adding a real `import` to that file silently
   produces a broken build (blank window). Verify with:
   `grep -c exports dist/renderer/index.js` -> must be 0.
2. **Build the DOM, never innerHTML.** Mod names and paths come from archives
   written by strangers. Everything goes through `textContent`.
3. **`safeJoin` every untrusted path.** Archive entries and mod-relative
   files are resolved through it so `../..` cannot escape the destination.
   Do not bypass it for "performance".
4. **Deployment must stay incremental.** The manifest diff is what makes a
   swap between two large profiles fast, and what produces the KEEP rows in
   the preview. Do not replace it with undeploy-everything-then-deploy.
5. **Never delete a displaced file.** If a deploy overwrites a real game
   file, it is moved to `shelf/<gameId>/displaced/` and the path is recorded
   in the manifest entry's `backup` field. Undeploy restores it.
6. **Protected paths are non-negotiable.** `isProtected()` blocks writes to
   game executables and base archives (`GTA5.exe`, `pakchunk*`, `x64`,
   `update`). A mod archive aimed there is broken or hostile.
7. **The three Definitive Editions share an identical `Gameface.exe` at an
   identical relative path.** Signature-file matching alone cannot tell them
   apart, so `matchesGame()` falls back to the install folder name for
   `era === 'de'`. Do not "simplify" that away.
8. Hard links only work within one volume. `deployProfile` checks
   `sameVolume()` and falls back to copying, surfacing a warning. Keep the
   warning - silent copying of a 6 GB texture pack is a bad surprise.
9. `blockWhileGameRunning` is on by default and checks `tasklist` for the
   **game executable only**. It used to also match launcher processes
   (`steam`, `rockstar`, anything starting with `launcher`), which made it
   fire permanently — Steam is always open — and blocked every deploy. Do not
   reintroduce that. `LAUNCHER_SHIMS` in `deploy.ts` additionally filters
   `PlayGTAV.exe` and friends out of the game's own executable list.
10. **Multi-game GitHub repos need per-game pinning.** Widescreen Fixes Pack
    covers ~100 unrelated games, one release per game, so `releases/latest` is
    whichever the author touched last — it really did offer San Andreas a
    Splinter Cell fix. Use `releaseTags` in the catalog. Likewise
    `assetPatterns`: the 3D era and GTA IV are 32-bit, GTA V and the
    remasters are 64-bit, and the wrong ASI loader silently never loads.
    `src/test/catalog.test.ts` pins all of this.
11. **`File.path` no longer exists.** Electron 32 removed it, so drag-and-drop
    handlers that read `file.path` get `undefined` and silently do nothing.
    Use `webUtils.getPathForFile` via the preload (`window.gtarageFiles`).
12. **Windows cannot combine `openFile` and `openDirectory`** in one
    `showOpenDialog` — it honours only one, which is why "Add mod" appeared to
    accept folders only. Hence two separate buttons and an `importMods(gameId,
    mode)` parameter.
13. The mod-site browser window must **never** get a preload or any bridge. It
    loads untrusted third-party sites; it is sandboxed, `contextIsolation` on,
    `nodeIntegration` off, and popups are restricted to the same registrable
    domain to kill ad pop-unders.
14. **Never attach a `data` listener to a stream you are also piping.** This
    caused every browser download to arrive with the correct length and
    shuffled contents (first divergence at exactly 128 KB, chunks displaced by
    16-32 KB), so archives imported as "Damaged ZIP: central directory ended
    early". Progress must be measured by a `Transform` inside the single
    `pipeline` call, as `net.ts` now does. A length check does not catch this;
    `src/test/download.test.ts` checks content.
15. **`findEocd` verifies its candidate.** Compressed data contains
    `PK\x05\x06` by chance, so a signature match alone is not the EOCD. The
    candidate is accepted only if `centralOffset + centralSize` lands exactly
    on it and a central-directory header sits at that offset.
16. **The HD-era games cannot be launched by running their main .exe.**
    `GTA5.exe` exits with `ERR_NO_LAUNCHER`. `launchWith` on the game
    definition holds the launch order (shim first); for Steam installs
    `launchGame` uses `steam://rungameid/<appid>` instead, which is the most
    reliable route. Note `launchWith` and `executables` are deliberately
    different lists -- detection wants the real binary, launching wants the
    shim.
17. **Classification failures are silent.** The kind decides the deploy root,
    so getting it wrong does not error — the files land somewhere the game
    never looks and the mod just does nothing. Two shipped examples:
    `dinput8.dll` classified as `script` (deployed to `scripts/`, so the ASI
    loader never loaded), and ScriptHookV's `bin/` folder not being unwrapped
    (everything deployed to `<game>/bin/`). Proxy-DLL names are now checked
    *before* the generic `.dll` rule, and `unwrapRoot` ignores loose
    documentation when deciding whether a single child folder is a wrapper.
    Covered by `src/test/classify.test.ts`.
18. **`repairLibrary` runs at startup** (`main/index.ts`) and re-applies the
    current import rules to existing entries — unwrap, then re-classify. This
    is how a shipped misclassification gets fixed without asking users to
    re-import. It only touches the library; deployed files are relocated by
    the normal diff on the next Apply.
19. **A mod must never depend on itself.** ScriptHookVDotNet ships
    `ScriptHookVDotNet.asi`, whose metadata references the ScriptHookVDotNet
    assembly, so the scanner concluded it required itself. `PROVIDER_FILES` in
    `depscan.ts` maps capability -> the files that *are* it; provided
    capabilities are dropped both at scan time and again in
    `missingDependencies`, so entries indexed by an older build self-correct.
20. **The catalogue is scoped per game, and so are the fixes it offers.**
    Ultimate ASI Loader is listed for GTA IV and the 3D era only: ScriptHookV
    already bundles an ASI loader (`dinput8.dll`) for GTA V, so listing UAL
    there made both mods claim the same file. The Definitive Editions use
    UE4SS and never UAL — checked against UAL's own README, which does not
    mention the trilogy remasters at all.
    Because of that, `RULES` in `depscan.ts` supports `essentialByGame`: the
    `asiloader` capability resolves to `scripthookv` on GTA V and
    `ultimate-asi-loader` elsewhere. `dependencyFixesFor()` exists so
    `catalog.test.ts` can assert every offered fix is something that game's
    catalogue can actually install — otherwise you ship an "Install" button
    that cannot succeed.
21. The online warning is **off by default** (`warnAboutOnline`). These titles
    launch into a story/online chooser, so warning on every swap is noise. The
    vanilla-lock profile and "Verify folder" are the real safety mechanisms
    and remain always-on.
21. **`protectedPaths` matches whole segments, not raw prefixes.** A bare
    `startsWith` made `x64` protect `x64_textures.asi` and `update` protect
    `updater.dll`, so ordinary mods were skipped with a message claiming they
    were part of the base game. Entries that really do want a prefix end in
    `*` (`pakchunk*`). Covered by `src/test/deploy.test.ts`.
22. **The manifest is the only record of where a displaced file went.** It
    must therefore survive every partial failure. If undeploy cannot remove a
    file, that entry stays in the manifest instead of the file being deleted;
    if a deploy displaces a game file and *then* fails to place the mod file,
    the backup is still recorded. Both used to strand the original with
    nothing left to say where it belonged.
23. **`repairLayout` must never `rm -rf` a wrapper it did not fully empty.**
    It skips entries whose destination already exists, then used to delete the
    whole wrapper anyway — destroying exactly the files it had just decided to
    preserve, silently, at startup, in the only copy that exists. It now
    prunes empty directories only.
24. **A corrupt config must not look like a first run.** `readJson` returns
    `null` for both, so a damaged file used to start the app on defaults and
    then overwrite it, losing every profile. `readJsonStrict` distinguishes
    them; the damaged file is copied aside and `configError` is surfaced in
    the UI. Config writes are serialised through a promise chain and use
    unique temp names, because concurrent IPC handlers could otherwise
    interleave and publish a half-written file.
25. **Only retry extraction for limitations, never for refusals.** The
    external-tool fallback used to catch *every* error from the built-in ZIP
    reader, including `safeJoin`'s traversal refusal — handing a hostile
    archive straight to 7-Zip and delegating containment to it. Traversal
    errors carry `code = 'ERR_UNSAFE_PATH'`; `isRetryable` in `extract.ts`
    allows only ZIP64 and unsupported-method errors through.
26. **`subarray` clamps, so extraction must bounds-check.** A truncated
    archive used to yield a short file with no error at all, and a
    half-written `.asi` deploys perfectly and simply never loads. Entry data
    is now checked against the buffer length and the declared
    `uncompressedSize`.
27. **Mod ids must be unique against the disk, not just the index.** A folder
    left by a failed import is invisible to `config.mods`, and renaming a new
    payload into it merged two unrelated mods. Import also cleans up the whole
    mod folder on any failure, not just extraction failures.
28. **`.cs` is a CLEO script only on the 3D era.** It is also every C# source
    file, and SHVDN mods ship their source, so GTA V users were told to
    install a runtime their game does not have. `RULES.cleo` is gated by
    `games`.
29. **First run is a guided setup, not an error message.** `renderSetup`
    replaces the old "not set up" empty state and is where "library" and
    "profile" get introduced. Handlers that need a configured game call
    `requireGame()`, which explains the refusal — several buttons used to
    silently do nothing on first launch.
30. **Applying is not bound to bare Enter.** It moves files and launches the
    game; it now needs Ctrl/Cmd+Enter. The global drop handler uses
    `pathsFromDrop` (see gotcha 11) — it read the removed `File.path` and so
    silently ignored every drop outside the load-order dropzone.

31. **`hidden` does not hide on its own.** The UA stylesheet's
    `[hidden] { display: none }` is a bare attribute selector, so any component
    rule that sets `display` outranks it. `.toolbar { display: flex }` meant
    `toolbar.hidden = true` silently did nothing and the search bar sat on top
    of the Load order, Browse and Saves tabs for months. There is now one
    global `[hidden] { display: none !important }`; do not remove it in favour
    of per-component guards, which is how this happened.
32. **Check a new CSS class does not already exist.** `.diff-row` and
    `.diff-sign` belonged to the ScriptHookV prompt long before the swap diff
    wanted the same names, so the new rules quietly restyled an unrelated
    dialog. The swap diff uses `swap-*`. `grep -c "^\.name" styles.css` before
    inventing a class.
33. **Layout inside the main column needs a container query, not a media
    query.** With the profile rail (236px) and the inspector (330px) both open,
    a 1400px window leaves the view 714px. A breakpoint on the viewport
    therefore never fires when it needs to, and the load-order split squeezed
    the diff into 300px while the window still looked wide. `.view` declares
    `container: view / inline-size` for this.
34. **The two typefaces are bundled, and must stay bundled.** `--sans` and
    `--mono` name Space Grotesk and JetBrains Mono; the CSP is `font-src 'self'`
    so a CDN link silently falls back to Segoe UI and Consolas, which is
    exactly what happened for the project's first several releases. The woff2
    files and their OFL licences live in `src/renderer/assets/fonts/`.
35. **The recorded game build means "what the user was told about".** It is
    written on acknowledge, never at detection time. Recording what is detected
    destroys the feature outright: the first state refresh overwrites the
    previous build and the alert is never shown to anyone.
36. **Style the element you actually create.** `.onpage a` was written for a
    list of links while the code builds `<button>` elements, so none of it
    matched and the rail fell through to the UA's default button chrome —
    eight white slabs down the side of a dark window. A rule that silently
    applies to nothing reads as a theming bug rather than a selector bug,
    which is what made it slow to spot. Match on the class, or check the tag.
37. **Measure a theme after the last render, not before.** `render()` rewrites
    `documentElement.dataset.theme` from state, so a harness that stamps the
    theme and *then* triggers a render measures the other one. Several
    dark-mode checks silently reported light this way and passed.

38. **The contextBridge object is frozen.** `window.gtarage.someMethod = ...`
    from devtools or a CDP harness silently does nothing in non-strict mode,
    so a stub meant to force an error path never takes and the test appears
    to prove the error path is unreachable. Force failures from the main
    process side, or render the view function directly with a fake state —
    top-level `function` declarations in the renderer are global, though
    `let`/`const` module state is not reachable that way.

## Verification

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run dev
```

`npm test` covers the planner rules (who wins a conflict, reorder effects,
vanilla-lock deploying nothing, swap in/out/kept counts, the blockers), the
deployment engine against a real temp game folder (`deploy.test.ts`: hard-link
identity, displacement and restore, incremental swaps, protected paths,
partial-failure recovery), and the file-loss regressions in `safety.test.ts`.

After touching the renderer, confirm it is still a classic script:

```bash
node -e "const t=require('fs').readFileSync('dist/renderer/index.js','utf8');console.log((t.match(/exports/g)||[]).length)"
```

Must print `0`.

## Build

```bash
npm run dist
```

Produces `release/GTArage-Setup-<version>.exe` (NSIS, per-user, no admin) and
`release/GTArage-<version>-portable.exe`. Icon is generated at
`build/icon.png`. `dist/test/**` and source maps are excluded from the
package.

## Tools (how mods arrive)

One provider plus an embedded browser (`src/shared/catalog.ts`,
`src/shared/sites.ts`, `src/main/providers/github.ts`,
`src/main/modsites.ts`). The Nexus API integration was removed; Nexus remains
only as a site you can open and download from by hand.

- **Drop a file** — the primary route, and the only one that needs no network
  and no account. It must stay the most prominent thing on the screen.
- **Essentials** — curated list resolved from the GitHub Releases API. No
  auth. Verified live: every repo in `ESSENTIALS` was checked against the API.
  `listEssentials` joins it with the library so each row arrives already
  decided: installed, outdated, manual-only, or not installed.
- **Sites** — GTA5-Mods, GTAinside, LibertyCity, ModDB, Nexus open in a real
  `BrowserWindow` on `persist:modsites`. `will-download` on that session
  redirects the file into staging and through the normal importer. Executables
  are staged but **never** imported or run. Sites flagged `docsOnly` (the
  GTAMods wiki) are filtered out of that column — it promises downloads.

All network access goes through `src/main/net.ts`, which enforces an HTTPS
host allowlist re-checked at every redirect hop, plus timeouts and a size cap.

## State of play

Verified on this machine:

- Detection found GTA V Enhanced (1.0.1158.13) and GTA V Legacy (1.0.3889.0)
  via the Steam library index.
- The Essentials provider was run live against GitHub for gta5 / gtasa /
  gtasade and returns correct, architecture-appropriate assets.
- Game-running detection returns false with Steam, steamservice and
  steamwebhelper all running (the bug it was written to fix).
- 85 unit tests pass, including a real PE import-table read of a Windows
  binary, a full ZIP build-and-extract round trip, a content-level
  download-ordering check over a local HTTP server, and the deploy/undeploy
  round trip against a real temp game folder.
- End-to-end download verified: ScriptHookVDotNet.zip and
  Ultimate-ASI-Loader_x64.zip fetch with byte-identical SHA-256 to an
  independent download, parse, and extract.
- Both packaged exes launch.

The deployment engine now has filesystem coverage, which found three real bugs
on its first run (gotchas 21 and 22). A subsequent audit of the import, config
and archive layers found several more file-loss paths, all fixed and pinned by
`src/test/safety.test.ts` (gotchas 23-27).

Not yet exercised live: the Tools screen's offline panel, which needs the
GitHub call to actually fail (see gotcha 38 for why stubbing it does not work).

## Suggested next steps

- Mod dependency *editing* in the UI (`requires` is enforced by the planner;
  `dependencies` is now detected automatically, but neither is user-editable).
- Per-profile graphics settings (`settings.xml`/`commandline.txt`) carried
  through a swap, which the original design sketched.
- **Linux support** (publicly announced as planned; see the README roadmap).
  The engine is already portable — library, deploy diff, hard links, ZIP,
  planner. What is not:
  - `detect.ts`: the registry probe and fixed-drive scan are Windows-only.
    Steam library parsing already works anywhere.
  - **Proton prefixes are the real work.** Game files live in the normal Steam
    library, but everything the game *writes* is under
    `steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/`. So
    `saves.ts` and `graphics.ts` cannot resolve against `~/Documents`; both
    need to route through the prefix for the right app id.
  - `isGameRunning` uses `tasklist` and currently **fails open** off Windows
    (returns false). That is a silent no-op, not a safe default — it must be
    implemented via `/proc` before Linux is called supported, or deploys will
    happily run under a live game.
  - Case sensitivity: mod archives are inconsistent about casing, and on ext4
    a mod shipping `Scripts/` lands somewhere the game never reads.
  - Launching is nearly free: `steam://rungameid/<id>` works via `xdg-open`.
- macOS is explicitly not planned; the games do not run there natively.
