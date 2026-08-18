# Changelog

Notable changes per release. Dates are release dates; versions link to their
tag.

The project was called **Swapmeet** up to and including 0.5.0-beta.1, and
**GTArage** from 1.0.0. Only 1.0.0 has a published download — the earlier
releases were withdrawn once it landed, though their tags are kept so any
point in the history can still be checked out.

---

## [1.0.0](https://github.com/DelusionalWizard/gtarage/releases/tag/v1.0.0)

The rename, a new interface, and the first release not labelled beta.

### Renamed

Swapmeet is now **GTArage**. Electron derives its data folder from the product
name, so the rename moves your library — it is migrated on first launch and the
stored paths are repointed. Nothing is deleted; the old folder is left in
place. The migration walks every name the app has had, so a version skipped
along the way still ends up with its library.

### Added

- **A new interface**, rebuilt from the ground up in a warm, plain-language
  design: Setups, Tools, Library, Backups, Settings. Light and dark.
- **Tools**, replacing Browse. Three routes in — a file you already have, the
  Essentials catalogue resolved live from official GitHub releases, and
  community sites opened in an embedded browser that catches your download.
  No search, because there is no catalogue to search.
- **A first-launch prompt** offering the load-bearing tools for the game you
  have, and recommending a clean game folder to start from. Shown once.
- **A Library screen**: every mod you own, which setups use it, and what
  nothing is using. Adding a mod to a second setup copies nothing.
- **Per-file toggles.** Exclude a single file inside a mod without removing the
  mod — per setup, and honoured by the conflict list, the preview and the
  deploy alike.
- **A game-update tripwire.** After a patch, GTArage compares the executable
  against the build it last told you about and names the mods likely to have
  stopped loading, rather than leaving you to guess.
- **dlclist and gameconfig awareness.** Add-on packs that are installed but not
  listed do nothing at all; the gap is detected and the exact line to add is
  handed to you. Past roughly eight packs, a bigger `gameconfig.xml` is
  suggested before the memory pools crash the game on load.
- **OpenIV packages are read rather than guessed at.** An `.oiv` is a script,
  and most of them write inside RPF archives, which GTArage cannot open. It now
  reports which half it can apply instead of installing something that changes
  nothing.
- **A BattlEye toggle** for GTA V Enhanced, writing `-nobattleye` into its Steam
  launch options. Refuses while Steam is running, since Steam would undo it.
- **Epic copies can be launched**, using the app id from Epic's own manifest.
- **A live swap summary**, so what the next press will add, remove and keep is
  visible while you are still deciding.
- **Remove all mods** per game, and a purge that removes everything GTArage has
  written to the machine, behind a typed confirmation.

### Changed

- **Switching and playing are two presses.** "Switch to *setup*" installs the
  mods and stops; the button then becomes Play now.
- Reordering moved onto the setup screen; the separate Load order screen is
  gone.
- The Nexus API integration was removed. The v1 API has no full-text search and
  direct downloads are Premium-only, so it promised more than it delivered.
  Nexus remains a site you open and download from.

### Fixed

- **A missing config no longer looks like a first run.** It could previously
  quarantine an entire library, because every folder looked unreferenced. This
  destroyed a real user's mods.
- **Mods that bring a folder with them are shelved whole**, leftovers included.
- **A failed provider lookup is no longer reported as a property of the mod.** A
  rate limit or a network error was being described as "must be downloaded by
  hand" — and cached for ten minutes. Failures are now distinguished from
  permanent link-outs, and are never cached.
- **Drag-to-reorder works.** It had never started a drag: the handler read the
  grip as the event target, which it never is.
- Deleting setups and mods was restored, along with per-file toggles, both of
  which had become unreachable.
- The two bundled typefaces are actually bundled. The CSS named them while the
  CSP blocked the CDN, so every release until now silently fell back.

---

## 0.5.0-beta.1

### Added

- **A self-updater**, in Settings → Updates: *Tell me* (default), *Install
  automatically*, or *Never check*, plus a Check now button.

  Downloading and running an executable is the most dangerous thing this app
  does, so: the release is read over HTTPS against a fixed host allowlist
  re-checked at every redirect hop; the installer's SHA-512 is verified against
  the published `latest.yml` and a mismatch is **deleted, not run**; the
  installer runs visibly rather than silently; and it will not restart while a
  game is running, so an update cannot interrupt a half-applied setup.

  The builds are unsigned, so that checksum is the only integrity guarantee
  there is — which is why it is checked rather than assumed. The portable build
  cannot replace itself, and says so instead of pretending.

  No new dependencies were added for it. GTArage still has zero runtime
  dependencies.

### Fixed

- Documentation files (readmes, licences, changelogs) are no longer reported as
  mod conflicts.
- The library cleanup quarantines unreferenced folders instead of deleting them.

---

## 0.4.2-beta.1

### Fixed

- Documentation files are no longer counted as file conflicts between mods.

---

## 0.4.1-beta.1

### Fixed

- **The orphan sweep could destroy mod files.** Fixed, and `.asi` mods are kept
  whole rather than split from the files that belong with them.
- The latest build is findable from the repository.

---

## 0.4.0-beta.1

### Added

- **Speedrunning mode**, off by default: a practice setup and the tools that
  community uses, kept out of the way for everyone else.
- **A light theme.**

### Fixed

- A bug that could account for 125 GB of disk.

---

## 0.3.0-beta.3

### Added

- A roadmap, including the statement that Linux support is planned.

### Changed

- Every game-folder write is guarded against the game running, not only the
  apply step.
- The documentation says plainly that the Definitive Editions are untested with
  real mods.

---

## 0.3.0-beta.2

First tagged build after the initial public release.

---

## 0.3.0-beta.1

Initial public release: a universal mod manager covering the 3D era, the
Definitive Editions, GTA IV, and GTA V Legacy and Enhanced.
