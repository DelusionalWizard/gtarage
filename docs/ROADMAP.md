# Roadmap - what the community actually asks for

Fourteen candidates, ranked against what GTArage already does. Drawn from
MO2-vs-Vortex threads, Vortex's issue tracker, GTA V modding guides and Script
Hook V breakage reports. Effort is against this codebase, not calendar time.

## Build next

1. **Game-update tripwire** (small). Rockstar patches, addresses move, every ASI
   mod dies until Script Hook V catches up. `detect.ts` already reads the exe
   `FileVersion` and throws it away. Store it per game; on launch, if it moved,
   say so, name the version-locked mods, offer the vanilla lock in one click.
   No other GTA mod manager does this.
2. **Warn before launch when Script Hook V is behind** (small). `scripthook.ts`
   already parses the build out of `ScriptHookV_3889.0_1158.13`. Compare it to
   the detected build and put the warning on Apply, not in a crash dialog.
3. **`dlclist.xml` awareness** (medium). An add-on pack with no dlclist entry
   installs perfectly and does nothing - the silent-failure class this project
   treats as a bug (gotcha 17). Writing the file needs an RPF writer (see 12);
   *detecting* the gap does not, and is most of the value. When a mod lands in
   `mods/update/x64/dlcpacks/<name>`, check for the entry and show the exact
   line to paste.
4. **Per-file toggles inside a mod** (medium). MO2's most-cited advantage over
   Vortex. The planner is already pure and already per-file. Add a per-profile
   exclusion set - per profile, not per mod, or two profiles sharing a mod
   fight over it.
5. **Mod update checking** (small). Same machinery as the 0.5.0 self-updater
   pointed at a different repo. Only works for mods installed through Browse;
   the UI must say so rather than imply a hand-dropped ZIP is current.

## Worth doing after

6. **Profile export/import** (medium). Collections without the hosting. Only
   catalogue and Nexus mods can be refetched; the rest can be named.
7. **Search/filter the load order** (small). Vortex's most-repeated UI
   complaint is scrolling past a hundred mods. Same shape of list here.
8. **Connect `gameconfig` to its trigger** (small). It is in the catalogue but
   never surfaced when DLC packs exhaust the memory pools. Count deployed
   packs and suggest it once it matters.
9. **Disk cost of the mods folder** (small). Keeping originals means
   duplicating archives. Show the number in the Apply preview.
10. **Suggest a load order** (medium). No LOOT masterlist exists for GTA, but
    the structural rules (loaders before what they load) are already derived in
    `depscan.ts`. Offer it as a suggestion, never a silent reorder - deciding
    on the user's behalf is exactly what Vortex is disliked for.

## Asked for, declined

11. **MO2-style virtual file system.** Needs DLL injection to fake a
    filesystem: a permanent fight with anti-cheat, broken by every patch. Hard
    links already give the stated benefit (originals untouched, instant
    swaps); the real remaining gap is per-file control, which item 4 closes.
12. **Built-in RPF editing.** Would make item 3 automatic and is why everyone
    still needs OpenIV. The archives are encrypted; shipping the means to
    decrypt them in an MIT project is a legal question, not an engineering
    one. Detect OpenIV/OpenRPF and hand off, as we already do with 7-Zip.
13. **Scraping GTA5-Mods / GTAinside.** No public API; scraping means
    impersonating a browser against sites that never agreed. The embedded
    browser stays the answer.
14. **Hosting collections.** A server, a moderation duty and an abuse surface
    for a project with nobody on call. Item 6 exports a file instead.

## Already answered

- No admin rights (per-user installer, hard links need no elevation).
- The Apply preview shows every file and every KEEP before anything moves -
  against Vortex's "apply or quit" prompt.
- Nothing is deleted: displaced files go to the shelf, orphans are quarantined.
- Drag to reorder, and order decides conflicts.
- A vanilla lock that verifies the folder before GTA Online.
