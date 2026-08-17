# Design brief: Settings and Browse

Paste into Claude Design, in the same project as the existing GTArage
mockups (`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so the new screens inherit
the 2a/2b language rather than starting a fresh visual direction.

---

## Prompt

Design two screens for **GTArage**, a mod manager for the Grand Theft Auto
games. They must sit inside the existing 2a/2b direction — "Clean & beginner
friendly": warm paper ground, white cards, hairline borders in the same warm
family, Space Grotesk for names and prose, JetBrains Mono for labels and
anything a person compares character by character. Exactly one saturated
colour (the blue) and it is reserved for the single action a screen is asking
for. Green means safe, orange means needs a decision. Everything is stated in
plain language: the existing screens say "How it looks", never "graphics
kind", and explain jargon in place rather than assuming it.

Both screens need a **dark variant** as well as light. The app ships both, and
the previous attempt failed by inverting the light idiom literally — a
near-black button on paper became a glaring white slab on a dark ground. In
dark, the emphatic surface should be the accent, not an inversion.

### Screen 1 — Settings

Today this is a long undifferentiated column of toggles, which makes the
dangerous ones look exactly like the cosmetic ones. Rework it so the weight
of each setting is visible.

Content, in whatever grouping you think reads best:

- **Where the game is.** A path per installed game, with "search again" and
  "choose folder". Five GTA titles may be present at once.
- **Safety.** Snapshot my saves before every switch (and how many to keep).
  Refuse to touch the game folder while the game is running. Warn before
  applying mods to a game that has an online mode. These are the ones that
  prevent losing a save or a ban — they should not look like preferences.
- **How files are placed.** Prefer hard links, fall back to copying across
  drives. Needs a sentence explaining why anyone would care: links cost
  almost nothing, copies duplicate a 6 GB texture pack.
- **Per-setup graphics.** Each setup carries its own settings.xml and launch
  options, applied on the switch.
- **Updates.** Tell me / install automatically / never check, plus "check now"
  and the current version.
- **Appearance.** Light or dark.
- **Speedrunning.** An opt-in extra surface, off by default.
- **Where my files live.** The library and shelf folders, with a way to open
  them. Read-only paths people occasionally need to find.

The hard part is hierarchy: a first-time user should be able to skim it
without meeting a single term they do not recognise, while someone hunting for
the hard-link setting can find it immediately.

### Screen 2 — Browse

Finding mods to install. Three sources that behave very differently, and the
old version made them look the same, which was the core mistake:

1. **Essentials** — a small curated list (Script Hook V, ASI loaders, .NET
   runtimes) fetched from official release pages. Reliable, few in number,
   and mostly "the pieces that let anything else run". Some are already
   installed; some are required by a mod the user already has.
2. **Community sites** — GTA5-Mods, GTAinside, LibertyCity, ModDB. No API, so
   these open a real browser window inside the app where the user logs in
   themselves and GTArage captures the download. This is a *handoff*, not a
   catalogue, and should look like one.
3. **A file the user already has** — drag in a .zip/.rar/.oiv/folder. Today
   this is buried, despite being how most mods actually arrive.

Requirements:

- Make the difference between "I can install this for you" and "I will open a
  site and catch what you download" obvious without a paragraph of text.
- An Essentials entry should be able to show state: not installed / installed
  / needed by something you have / an update is available.
- Show a mod's size and what it needs before installing, not after.
- No search box, no sort dropdown, no refresh button. The previous version had
  all three and none earned their place on a list this short.
- The drop target for a local file should be a first-class part of the screen.

Do not design a Nexus integration. It is being removed.

### Notes

- Window chrome is the app's own: a 44px white title strip with a breadcrumb
  (`GTArage › Settings`) and the window buttons. Both screens are reached
  from a quiet top nav, not tabs.
- Assume a 1280×900 window, resizable, and that the content column can be as
  narrow as ~700px when other panels are open.
- Nothing here should require a modal. The previous version leaned on dialogs
  and they were removed for being interruptive.
