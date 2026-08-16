## New: Swapmeet can update itself

**Settings → Updates**, with three choices:

- **Tell me** (default) — checks on launch, and says so if there is a newer version.
- **Install automatically** — downloads and installs without asking.
- **Never check** — no network requests for updates at all.

There is also a **Check now** button.

### How it is done, since an updater downloads and runs an executable

That is the most dangerous thing this app does, so:

- The release is read from the GitHub API over HTTPS, against a fixed host allowlist that is re-checked at **every redirect hop**.
- The installer's **SHA-512 is verified** against `latest.yml`, the checksum manifest published alongside it. A download that does not match is **deleted, not run**.
- The installer is run visibly, not silently. You see what is installing itself over your mod manager.
- Swapmeet **will not restart while a game is running**, so an update can never interrupt a half-applied profile.

The builds are unsigned, so that checksum is the only integrity guarantee there is — which is exactly why it is checked rather than assumed.

If you use the **portable** build, it cannot replace itself. Swapmeet will tell you and open the releases page instead of pretending.

No new dependencies were added for this. Swapmeet still has zero runtime dependencies.

---

Also in this release: documentation files (READMEs, licences, changelogs) are no longer reported as mod conflicts, and the library cleanup quarantines unreferenced folders instead of deleting them.
