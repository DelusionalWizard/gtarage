# GTArage

**An open-source universal mod manager for the Grand Theft Auto games.**

GTArage manages mods for every mainline GTA title from one app: the 3D era, the
Definitive Edition remasters, and the HD era. It keeps your mods in a library
outside the game folder and *deploys* them on demand, so switching between a
heavily modded roleplay setup and a clean install is a few seconds of file
moves rather than a reinstall.

MIT licensed.

**[Download the latest release →](https://github.com/DelusionalWizard/gtarage/releases/latest)**

[What changed, per release →](CHANGELOG.md)

---

> ### ⚠️ Read this first
>
> **This writes to your real game folders.** 1.0.0 is the first release that
> is not labelled beta, but it has still not been through many hands, and you
> may be the person who finds out something is wrong.
>
> - **Back up your game folder and saves before first use.** GTArage takes
>   save snapshots automatically and never deletes a displaced file, but a
>   backup you made yourself is the one you can rely on.
> - **Modding GTA Online is a ban.** GTArage gives every game a
>   vanilla-locked profile and a folder check, but nothing can make online
>   modding safe. Apply the vanilla profile before you go online.
> - **The Windows builds are unsigned.** SmartScreen will warn you, and you
>   should be sceptical of unsigned binaries from anyone. Building from source
>   is three commands and is the option I would take. Dropping "beta" from the
>   version number did not change this.
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

## Getting mods in

The **Tools** tab is where mods arrive. There is no catalogue and no search
box, because there is nothing to search: GTArage does not scrape mod sites and
never will. Mods reach your library one of three ways, and the screen makes
them look as different as they behave.

**Drop a file you already have.** A `.zip`, `.rar`, `.oiv`, a folder, or a
loose `.asi` — dragged anywhere onto the window. This works offline, with no
account, and it is how most mods actually get installed.

**Essentials** — a short, curated list of the load-bearing tools everything
else depends on (ASI loaders, ScriptHookV .NET, RageOpenV, CLEO Redux,
modloader, SilentPatch, Widescreen Fixes, UE4SS), resolved live from their
official GitHub release pages. No account, no key, one press to install.
GTArage picks the right build for the game: the 32-bit ASI loader for San
Andreas, the 64-bit one for GTA V, `SilentPatchSA` rather than `SilentPatchVC`.

Each entry shows where you stand with it: installed and current, installed and
behind (with the version it would move to), not installed, or — for the few
tools whose authors publish no downloadable release — a link to the page
instead of a download URL GTArage would have to invent. When a lookup fails,
it says it could not check and offers to try again, rather than claiming the
tool must be fetched by hand.

**Community sites** — GTA5-Mods, GTAinside, LibertyCity, ModDB, Nexus — open
in a real browser window inside the app. You log in yourself, on the real
site, and download normally. GTArage's only involvement is catching the file
at the end and importing it. No scraping, no automated clicking, no ToS
problem, and your password is never seen by GTArage. That window gets no
preload and none of GTArage's API, so a compromised mod site cannot reach your
filesystem. Executables are saved but never run or imported.

There is no Nexus API integration. It was removed: the v1 API has no full-text
search and direct downloads are Premium-only, so it promised more than it
could deliver. Nexus is a site you open and download from like any other.

`gtamods.com` is listed separately as documentation — it is a wiki and hosts
no mod files, so it never appears among places you can download from.

The Essentials list is scoped per game rather than offering everything
everywhere. ASI loaders are the clearest case:

| Game | Where the ASI loader comes from |
|---|---|
| GTA V / Enhanced | **ScriptHookV** — its download already bundles one (`dinput8.dll`), plus the Native Trainer |
| GTA IV, San Andreas, Vice City, GTA III | **Ultimate ASI Loader** — these ship without one |
| Definitive Editions | Neither: they are Unreal Engine 4 and use **UE4SS** |

Offering Ultimate ASI Loader on GTA V would be worse than redundant — both it
and ScriptHookV claim `dinput8.dll`, so it would manufacture a file conflict
the user then has to resolve for no benefit.

### First launch

The one time GTArage interrupts you unasked. Nearly every "my mods do nothing"
report comes down to two causes, and both are cheap to fix before you start
and miserable to diagnose afterwards: a missing or mismatched Script Hook V,
and a game folder still carrying leftovers from a previous modding attempt.

So the first-launch prompt says exactly that — start from a clean game folder,
and here are the load-bearing tools for the game you have, ticked and ready to
install. It appears once, whichever way you answer.

## Dependency detection

When a mod is imported, GTArage works out what it needs by reading the files
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
profiles of a 100 GB game do not need a dozen copies. (GTArage falls back to
copying when the library and the game are on different drives, and tells you
so.)

**You see the diff before anything moves.** Applying a profile opens a preview
listing exactly which mods leave the game folder, which arrive, and which are
shared and stay put — plus any blockers (game running, missing dependency, not
enough disk space) and warnings.

**Conflicts are explained, not hidden.** When two mods write the same file,
GTArage names both, names the winner, and tells you the rule: whichever sits
lower in the load order wins. Drag the stack to change the answer.

**An online safety valve.** Every game gets a vanilla-locked profile that
deploys nothing. "Verify folder" scans the places mods actually land and
reports stray `.asi`/`.dll`/`.pak` files that GTArage did *not* put there — the
ones left behind by manual installs. The online *warning* is off by default,
since GTA V asks story-or-online on every launch and warning on every swap is
noise; turn it on in Settings if you play online.

**Switching and playing are two presses.** "Switch to *setup*" installs that
setup's mods and stops. The button then becomes Play now. Choosing a setup no
longer starts the game as a side effect, so there is a moment to look at what
changed before anything launches.

**Your saves are snapshotted before every switch**, automatically, and kept
per game with the time each was taken. Restoring one is a couple of presses in
Backups.

**Files inside a mod can be switched off individually.** A mod that ships a
config you have already tuned by hand does not have to be all-or-nothing —
open its ⋯ menu and exclude that one file. Exclusions are per setup, and they
propagate everywhere: the conflict list, the swap preview and the deploy all
see the same reduced file list.

## Looking after a modded install

**It notices when the game updates.** Rockstar patches, Script Hook V stops
matching the new build, and every ASI plugin silently fails to load with no
error anywhere — this is the single most common way a working setup breaks.
GTArage records the build it last told you about, compares the executable on
each launch, and names the mods that are likely affected rather than leaving
you to guess which of forty things to blame. It also reads the build numbers
out of your Script Hook V copy and says whether they match.

**Add-on DLC packs are checked against `dlclist.xml`.** An add-on car or map
installs into `dlcpacks/` and does absolutely nothing unless it is also listed
in a file that lives *inside* `update.rpf`. GTArage cannot write into that
archive — see the OpenIV note below — but it detects the gap and hands you the
exact line to add. Past roughly eight add-on packs it also suggests a
replacement `gameconfig.xml`, because the stock memory pools run out and the
game crashes on load with nothing on screen to say why.

**OpenIV packages are read, not guessed at.** An `.oiv` is a *script*, not a
folder of files: `assembly.xml` lists operations, and most real packages write
inside RPF archives. GTArage cannot open those — RPF is a proprietary
encrypted container, and shipping the means to decrypt it is a legal question
rather than an engineering one. So it reads the assembly and tells you which
half it can apply: a package that only copies files installs like any other
mod, one that only edits archives says so and sends you to OpenIV, and the
awkward middle case warns that it will be only partly installed rather than
leaving you to work out which half worked.

**BattlEye can be switched off for GTA V Enhanced**, from Settings, by writing
`-nobattleye` into that game's Steam launch options — which is what lets
script mods load at all. GTArage refuses while Steam is running, because Steam
rewrites its own settings on exit and would silently undo the change, and it
backs up the file it edits. Story mode only: going online with mods loaded is
what gets accounts banned, with or without the anti-cheat.

**Mods already in your game folder can be adopted.** Almost nobody arrives at
a mod manager with a clean install, so GTArage scans the places mods actually
land, ignores everything the base game ships and everything it deployed
itself, and offers what is left as recognisable tools. Adopting copies them
into the library, so the game folder is untouched if it goes wrong.

**Starting over is possible without hunting through folders.** Settings has a
per-game "Remove all mods", which puts the game folder back as it was without
deleting anything from your library, and a purge that removes everything
GTArage has ever written to the machine — gated behind typing REMOVE, because
it is the one genuinely irreversible action in the app.

**Light and dark.** The interface ships both and asks once which you want.

**Speedrun mode**, off by default, adds a practice setup and pointers to the
tools that the community actually uses, kept separate so it does not clutter the
app for everyone else.

---

## Install

Grab a build from the
[latest release](https://github.com/DelusionalWizard/gtarage/releases/latest):

- `GTArage-Setup-1.0.0.exe` — normal installer (per-user, no admin required,
  choose your own install directory).
- `GTArage-1.0.0-portable.exe` — single-file portable build, no installation.

GTArage checks for its own updates and can install them for you; the check can
be turned off in Settings.


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

GTArage reads `.zip` and `.oiv` archives itself (both are ZIP containers) with
a small dependency-free reader, strips redundant wrapper folders, and
classifies what is inside. If an archive already uses game-relative folders
(`scripts/`, `mods/`, `CLEO/`), it is deployed verbatim; otherwise the kind is
inferred from the file extensions.

`.rar` and `.7z` — and ZIP64 archives, which the built-in reader deliberately
refuses rather than half-extracting — are handled by shelling out to 7-Zip or
WinRAR if either is installed. If neither is, the error says so instead of
failing vaguely.

You can drag files or folders anywhere onto the window, or use **Add mod
files** / **Add a folder**. Those are two separate buttons because Windows
cannot show one dialog that accepts files *and* folders at once.

---

## Project layout

```
src/
  shared/     types, the game registry, the mod catalogue and site list,
              and the pure planner logic
  main/       Electron main: detection, library, deployment, saves,
              archive extraction, dependency scanning, the mod-site browser
  main/providers/  GitHub Releases (the Essentials catalogue)
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
is a quiet one — GTArage will report a clean install and the game will simply
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
- **Epic copies have never been launched from GTArage on real hardware.**
  Detection is verified; the launch path uses the app id out of Epic's own
  manifest, but there is no Epic install on the development machine.
- Modding GTA Online is a ban. GTArage warns and gives you a locked vanilla
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
- Mod dependency editing in the UI — `requires` is enforced by the planner and
  `dependencies` is detected automatically, but neither is user-editable yet.
- `.rar`/`.7z` without needing 7-Zip or WinRAR installed.

Contributions welcome, and the Linux work in particular is well-suited to
someone who actually plays through Proton and can tell when a path is wrong.

---

## Licence

MIT — see [LICENSE](LICENSE).
