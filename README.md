# Swapmeet

**An open-source universal mod manager for the Grand Theft Auto games.**

Swapmeet manages mods for every mainline GTA title from one app: the 3D era, the
Definitive Edition remasters, and the HD era. It keeps your mods in a library
outside the game folder and *deploys* them on demand, so switching between a
heavily modded roleplay setup and a clean install is a few seconds of file
moves rather than a reinstall.

MIT licensed.

**[Download the latest release →](https://github.com/DelusionalWizard/swapmeet/releases/latest)**

---

> ### ⚠️ Beta — read this first
>
> **This is early software that writes to your real game folders.** It is
> tested, but it has not been through many hands yet, and you are the person
> who finds out if something is wrong.
>
> - **Back up your game folder and saves before first use.** Swapmeet takes
>   save snapshots automatically and never deletes a displaced file, but a
>   backup you made yourself is the one you can rely on.
> - **Modding GTA Online is a ban.** Swapmeet gives every game a
>   vanilla-locked profile and a folder check, but nothing can make online
>   modding safe. Apply the vanilla profile before you go online.
> - **The Windows builds are unsigned.** SmartScreen will warn you, and you
>   should be sceptical of unsigned binaries from anyone. Building from source
>   is three commands and is the option I would take.
> - Windows is the only tested platform today. Linux support is planned — see
>   the roadmap.
> - **The Definitive Edition trilogy is untested with actual mods** — see the
>   caveats section before relying on it there.
>
> Bug reports are genuinely useful right now — especially anything involving a
> mod that did not deploy where you expected.

---

## Supported games

| Game | Era | Mod formats |
|---|---|---|
| GTA V Enhanced | HD (RAGE) | ASI, ScriptHookV/.NET scripts, OpenIV `.oiv`, `mods/` replacements, ENB/ReShade |
| GTA V Legacy | HD (RAGE) | ASI, ScriptHookV/.NET scripts, OpenIV `.oiv`, `mods/` replacements, ENB/ReShade |
| GTA IV / EFLC | HD (RAGE) | ASI, scripts, ENB/ReShade |
| San Andreas – Definitive Edition | UE4 ⚠️ | `.pak`/`.ucas`/`.utoc`, UE4SS Lua, DLL wrappers |
| Vice City – Definitive Edition | UE4 ⚠️ | `.pak`/`.ucas`/`.utoc`, UE4SS Lua, DLL wrappers |
| GTA III – Definitive Edition | UE4 ⚠️ | `.pak`/`.ucas`/`.utoc`, UE4SS Lua, DLL wrappers |
| San Andreas (original) | 3D | CLEO, modloader, ASI, ENB |
| Vice City (original) | 3D | CLEO, modloader, ASI, ENB |
| GTA III (original) | 3D | CLEO, modloader, ASI, ENB |

> ⚠️ **The Definitive Editions are untested with real mods.** Detection and
> deploy paths are verified, but no `.pak` has ever been confirmed loading
> in-game. See
> [Caveats](#the-definitive-editions-have-not-been-tested-with-actual-mods).

The Definitive Editions are treated as genuinely different games rather than
reskins, because they are: they are the classic titles hosted in Unreal Engine
4, so CLEO and modloader do not apply and mods ship as UE4 `.pak` files that
load out of a `~mods` folder.

---

## Finding mods

Swapmeet has a **Browse** tab with two halves, because mods come from two very
different kinds of place.

**Sources with a real API** are listed in-app:

- **Essentials** — a curated catalogue of the load-bearing tools everything
  else depends on (ASI loaders, ScriptHookV .NET, CLEO Redux, modloader,
  SilentPatch, Widescreen Fixes, UE4SS), resolved live from their official
  GitHub releases. No account, no configuration, one click to install. Swapmeet
  picks the right build for the game: the 32-bit ASI loader for San Andreas,
  the 64-bit one for GTA V, `SilentPatchSA` rather than `SilentPatchVC`.
- **Nexus Mods** — via the official API and your own personal key, stored
  encrypted with the Windows credential store. Two honest limits, both stated
  in the UI: the v1 API has no full-text search (so the box filters the feed),
  and direct API downloads are a Premium feature — for everyone else Swapmeet
  registers the `nxm://` handler so the site's own "Mod Manager Download"
  button works.

**Sources without an API** — GTA5-Mods, GTAinside, LibertyCity, ModDB — open
in a real browser window inside the app. You log in yourself, on the real site,
and browse normally. Swapmeet's only involvement is catching the download at the
end and importing it into the library. No scraping, no automated clicking, no
ToS problem, and your password is never seen by Swapmeet. The embedded window
gets no preload and none of Swapmeet's API, so a compromised mod site cannot
reach your filesystem.

A few tools (ScriptHookV, OpenIV) are distributed only from their authors' own
sites. Swapmeet lists them, explains why, and opens the page — it never invents
a download URL.

The catalogue is scoped per game rather than offering everything everywhere.
ASI loaders are the clearest case:

| Game | Where the ASI loader comes from |
|---|---|
| GTA V / Enhanced | **ScriptHookV** — its download already bundles one (`dinput8.dll`), plus the Native Trainer |
| GTA IV, San Andreas, Vice City, GTA III | **Ultimate ASI Loader** — these ship without one |
| Definitive Editions | Neither: they are Unreal Engine 4 and use **UE4SS** |

Offering Ultimate ASI Loader on GTA V would be worse than redundant — both it
and ScriptHookV claim `dinput8.dll`, so it would manufacture a file conflict
the user then has to resolve for no benefit.

`gtamods.com` appears too, but only as documentation: it is a wiki and hosts no
mod files. Swapmeet deep-links it to explain what a `handling.meta` or an `.img`
archive actually is.

## Dependency detection

When a mod is imported, Swapmeet works out what it needs by reading the files
rather than trusting a description:

- **PE import tables.** An `.asi` or `.dll` is a Windows binary whose import
  directory literally names the DLLs it links against. If it imports
  `ScriptHookV.dll`, that is not a guess — it is the loader's own answer.
- **.NET assembly references**, for managed script mods built against
  ScriptHookVDotNet.
- **Layout**: CLEO scripts, a `modloader/` folder, an `assembly.xml`, Lua in a
  Definitive Edition mod.
- **Readme text**, last and weakest.

Missing prerequisites appear in the inspector ahead of file conflicts — with a
missing script hook nothing loads at all, so the conflict is academic. Each one
shows the evidence that produced it, so you can tell "imports ScriptHookV.dll"
apart from "the readme mentions it", and install it in one click.

## What makes it different

**Nothing is ever deleted.** When a mod would overwrite a real game file, the
original is moved to a *shelf* folder first and its location is written into a
manifest. Undeploying replays that manifest in reverse and puts everything
back byte-for-byte.

**Profiles cost almost no disk space.** Deployed files are hard links to the
library copy — a second directory entry for bytes that already exist. A dozen
profiles of a 100 GB game do not need a dozen copies. (Swapmeet falls back to
copying when the library and the game are on different drives, and tells you
so.)

**You see the diff before anything moves.** Applying a profile opens a preview
listing exactly which mods leave the game folder, which arrive, and which are
shared and stay put — plus any blockers (game running, missing dependency, not
enough disk space) and warnings.

**Conflicts are explained, not hidden.** When two mods write the same file,
Swapmeet names both, names the winner, and tells you the rule: whichever sits
lower in the load order wins. Drag the stack to change the answer.

**An online safety valve.** Every game gets a vanilla-locked profile that
deploys nothing. "Verify folder" scans the places mods actually land and
reports stray `.asi`/`.dll`/`.pak` files that Swapmeet did *not* put there — the
ones left behind by manual installs. The online *warning* is off by default,
since GTA V asks story-or-online on every launch and warning on every swap is
noise; turn it on in Settings if you play online.

---

## Install

Grab a build from `release/`:

- `Swapmeet-Setup-0.3.0-beta.1.exe` — normal installer (per-user, no admin required,
  choose your own install directory).
- `Swapmeet-0.3.0-beta.1-portable.exe` — single-file portable build, no installation.

### Build from source

Requires Node.js 20+.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run dist
```

`npm run dist` produces both Windows targets in `release/`.

---

## How it works

```
library/<game>/<mod>/content/…     mods live here, outside the game
shelf/<game>/deployed.json         manifest of every deployed file
shelf/<game>/displaced/…           game files a mod displaced
shelf/<game>/saves/<timestamp>/…   save snapshots
```

Deployment walks the enabled mods **in load order**, maps each of their files
to a game-relative destination based on the mod's kind, and lets later mods
overwrite earlier claims. That single rule produces both the file layout and
the conflict list, so what the UI shows you and what lands on disk cannot
disagree.

Where a mod's files land is data, not code — each game definition carries a
`deployRoots` table:

```
GTA V         asi -> game root, script -> scripts/, oiv|replace -> mods/
San Andreas   cleo -> CLEO/, modloader -> modloader/, asi -> game root
SA (DE)       pak -> Gameface/Content/Paks/~mods/, lua -> …/ue4ss/Mods/
```

Adding a new title means adding one entry to `src/shared/games.ts`.

### Import

Swapmeet reads `.zip` and `.oiv` archives itself (both are ZIP containers) with
a small dependency-free reader, strips redundant wrapper folders, and
classifies what is inside. If an archive already uses game-relative folders
(`scripts/`, `mods/`, `CLEO/`), it is deployed verbatim; otherwise the kind is
inferred from the file extensions.

`.rar` and `.7z` — and ZIP64 archives, which the built-in reader deliberately
refuses rather than half-extracting — are handled by shelling out to 7-Zip or
WinRAR if either is installed. If neither is, the error says so instead of
failing vaguely.

You can drag files or folders anywhere onto the window, or use **Add files** /
**Add folder**. Those are two buttons rather than one because Windows cannot
show a dialog that accepts files *and* folders at once.

---

## Project layout

```
src/
  shared/     types, the game registry, the mod catalogue and site list,
              and the pure planner logic
  main/       Electron main: detection, library, deployment, saves,
              archive extraction, dependency scanning, the mod-site browser
  main/providers/  GitHub Releases and Nexus Mods
  preload/    the contextBridge, the only path from UI to filesystem
  renderer/   the UI (no framework, no bundler)
  test/       node:test coverage of the rules that matter
```

`src/shared/planner.ts` is pure functions over plain data — load order,
conflicts and the swap plan — so the rules users get burned by are testable
without a game install. Run them with:

```bash
npm test
```

---

## Security notes

The renderer runs with `contextIsolation` on, `nodeIntegration` off, a strict
CSP, and navigation blocked. It builds its DOM with `textContent` rather than
HTML strings, because mod names and file paths are untrusted input. Archive
entry paths are resolved through a containment check, so an archive containing
`../../Windows/System32/…` is rejected rather than extracted. Deployment
refuses to write to a game's protected paths (executables, base archives).

---

## Caveats

### The Definitive Editions have not been tested with actual mods

This is the biggest gap, so it gets its own heading.

What **is** verified for GTA III, Vice City and San Andreas – Definitive
Edition: all three are detected correctly on a real machine, told apart from
each other despite sharing an identical `Gameface.exe`, and their deploy paths
are unit-tested — a `.pak` maps to `Gameface/Content/Paks/~mods/`, a Lua mod
to the UE4SS folder, and the engine's own DLLs in `Gameface/Binaries/Win64`
are correctly refused as adoption candidates.

What is **not** verified: no real `.pak`, `.ucas`/`.utoc` or UE4SS Lua mod has
ever been deployed to a Definitive Edition install and confirmed to load
in-game. The paths come from how the UE4 `~mods` convention works, not from
watching a mod actually run. If the layout is wrong in some way, the failure
is a quiet one — Swapmeet will report a clean install and the game will simply
ignore the files.

So: on the DE trilogy, treat this as untested. Use "Check the game folder"
after applying, keep a backup, and please open an issue either way — a report
that it *worked* is as useful as one that it did not.

The HD era (GTA V Legacy and Enhanced, GTA IV) and the 3D era are the paths
that have seen real use.

### Everything else

- Windows is the only tested platform today. **Linux support is planned** —
  see [Roadmap](#roadmap) for what already works and what is genuinely in the
  way.
- The Nexus provider is written against the documented API but has not been
  exercised against a live key — that needs your own account. It is the
  largest untested surface after the DE trilogy.
- Modding GTA Online is a ban. Swapmeet warns and gives you a locked vanilla
  profile, but it cannot make online modding safe — nothing can.
- Definitive Edition Steam app ids in the registry are best-effort; detection
  confirms every folder by signature file, so a wrong id costs nothing.

---

## Roadmap

### Linux support

**Planned, and the hard part is smaller than it looks.** The engine is already
platform-agnostic: the library, the deployment diff, hard links, the ZIP
reader, load order and conflict resolution are all plain Node with no Windows
assumptions. `sameVolume` already falls back to comparing device ids off
Windows, and the archive extractor already looks for `7z` on `PATH` rather
than only in `Program Files`.

What actually needs doing, roughly in order of difficulty:

- **Proton prefixes.** This is the real work, and it is not a port — it is a
  mapping problem. Under Proton the game files sit in the normal Steam
  library, but everything the game writes lives inside
  `steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/`. So saves,
  `settings.xml` and `commandline.txt` are not in `~/Documents` at all, and
  every save-snapshot and per-profile-settings path has to resolve through the
  prefix for the right app id.
- **Game detection.** Steam library parsing already works anywhere; the
  Windows registry probe and the fixed-drive scan simply do not apply, and
  need replacing with the usual Linux Steam roots.
- **Is the game running.** Currently `tasklist`, which does not exist. Needs a
  `/proc`-based check. Note this fails *open* today on non-Windows — it
  returns "not running" — so it must be implemented rather than left as a
  silent no-op before Linux is called supported.
- **Launching.** `steam://rungameid/<id>` already works through `xdg-open`, so
  this is mostly free.
- **Case sensitivity.** Windows filesystems are case-insensitive and mod
  archives are wildly inconsistent about casing. On ext4 a mod shipping
  `Scripts/` instead of `scripts/` lands in the wrong place, so path matching
  needs to be deliberate about case rather than accidentally correct.

macOS is not planned: the games do not run there natively, and nothing in the
Rockstar catalogue targets it.

### Also on the list

- An end-to-end test against a real Definitive Edition install, which is the
  largest untested surface (see [Caveats](#caveats)).
- The Nexus provider exercised against a live API key.
- Mod dependency editing in the UI — `requires` is enforced by the planner and
  `dependencies` is detected automatically, but neither is user-editable yet.
- `.rar`/`.7z` without needing 7-Zip or WinRAR installed.

Contributions welcome, and the Linux work in particular is well-suited to
someone who actually plays through Proton and can tell when a path is wrong.

---

## Licence

MIT — see [LICENSE](LICENSE).
