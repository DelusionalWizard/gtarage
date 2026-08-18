# Changelog

Notable changes per release.

---

## [1.0.0](https://github.com/DelusionalWizard/gtarage/releases/tag/v1.0.0)

First release.

### Added

- **Setups.** Mods live in a library outside the game folder; a setup is an
  ordered selection from it. Switching installs one and removes the other, and
  every game gets an undeletable vanilla setup that deploys nothing, for going
  online.
- **Tools**, where mods arrive: a file you already have, the Essentials
  catalogue resolved live from official GitHub release pages, or a community
  site opened in an embedded browser that catches your download. No search,
  because there is no catalogue to search — GTArage does not scrape.
- **A first-launch prompt** offering the load-bearing tools for the game you
  have, and recommending a clean game folder to start from. Shown once.
- **Library.** Every mod you own, which setups use it, and what nothing is
  using. Adding a mod to a second setup copies nothing.
- **Conflict explanations.** When two mods claim the same file, GTArage names
  both, names the winner, and gives the rule — later in the order wins. Drag to
  change the answer.
- **A live swap summary**, so what the next press will add, remove and keep is
  visible while you are still deciding.
- **Per-file toggles.** Exclude a single file inside a mod without removing the
  mod — per setup, and honoured by the conflict list, the preview and the
  deploy alike.
- **Save snapshots** before every switch, kept per game with the time each was
  taken.
- **Dependency detection** by reading the files rather than the description: PE
  import tables, .NET assembly references, and layout.
- **A game-update tripwire.** After a patch, GTArage compares the executable
  against the build it last told you about and names the mods likely to have
  stopped loading.
- **dlclist and gameconfig awareness.** Add-on packs installed but not listed do
  nothing at all; the gap is detected and the exact line to add is handed to
  you. Past roughly eight packs, a bigger `gameconfig.xml` is suggested before
  the memory pools crash the game on load.
- **OpenIV packages are read rather than guessed at.** An `.oiv` is a script,
  and most of them write inside RPF archives, which GTArage cannot open. It
  reports which half it can apply instead of installing something that changes
  nothing.
- **A BattlEye toggle** for GTA V Enhanced, writing `-nobattleye` into its Steam
  launch options. Refuses while Steam is running, since Steam would undo it.
- **Mod adoption**, for mods already sitting in the game folder.
- **A self-updater**: tell me, install automatically, or never check. The
  installer's SHA-512 is verified against the published manifest, and a
  mismatch is deleted rather than run.
- **Epic and Steam copies both launch correctly**, using the storefront's own
  route rather than the executable.
- **Light and dark**, and an optional speedrunning mode.
- **Remove all mods** per game, and a purge that removes everything GTArage has
  written to the machine, behind a typed confirmation.

### Notes

Nothing is ever deleted. A game file a mod overwrites is moved to a shelf and
its location recorded; undeploying puts it back byte-for-byte.

Deployed files are hard links, so a dozen setups of a large game do not need a
dozen copies. GTArage falls back to copying across drives, and says so.

The Windows builds are unsigned. The Definitive Editions are supported but have
not been confirmed loading a real mod in-game, and Epic launching has not been
exercised on real hardware.
