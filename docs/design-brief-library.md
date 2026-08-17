# Design brief: Library

Paste into Claude Design, in the same project as the existing GTArage
mockups (`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so it inherits the 2a/2b
language and the conventions already set by Settings & Browse.

---

## Prompt

Design the **Library** screen for **GTArage**, a mod manager for the Grand
Theft Auto games. It is the fourth item in the app's navigation, alongside
Setups, Browse and Settings.

Stay inside the established direction: warm paper ground, white cards,
hairline borders in the same warm family, Space Grotesk for names and prose,
JetBrains Mono for labels and anything compared character by character.
Exactly one saturated colour (the blue), reserved for the single action a
screen is asking for. Green means safe or done, orange means needs a decision.
Plain language throughout — the existing screens say "How it looks", never
"graphics kind". Design **light and dark**; in dark the emphatic surface is
the accent, never an inversion of the light idiom to white.

### The problem it solves

GTArage keeps mods in a **library**, and a **setup** is an ordered selection
from that library. Today the app only ever shows the mods that are in the
setup you happen to have open. That means:

- A mod imported while one setup was open is **invisible from every other
  setup**, while still occupying disk.
- There is **no way to add a mod you already have to a second setup** — the
  only route is importing it again.
- Nothing lists mods that no setup uses at all, so they accumulate unnoticed.

The Library screen is where a mod exists independently of any setup. That
relationship — one mod, used by zero or more setups — is the thing the design
has to make legible, and it is the interesting problem here.

### What it holds

Every mod for the currently selected game. For each one GTArage knows:

- Name, version, and size on disk.
- What kind it is, in plain words: how it plays / how it looks / game files /
  needed to run mods.
- **Which setups use it** — none, one, or several, by name.
- Whether it is *required* by another mod the user has (Script Hook V is
  needed by most script mods).
- Whether it is currently installed in the game folder.
- How many files it contains, and when it was added.

### What someone comes here to do

- Find out what they actually have, and how much space it is using.
- **Put a mod they already own into another setup**, without re-importing.
- Take a mod out of a setup without deleting it from the library — those are
  two genuinely different actions and the design should not blur them.
- Delete a mod from the library for good, when they are sure.
- Notice mods nothing is using.

### Constraints and cautions

- **A search or filter is appropriate here**, unlike Browse. A library can hold
  hundreds of mods; Browse's Essentials list holds eight. Do not copy Browse's
  "no search box" decision into this screen without thinking about it.
- **No modals.** Dialogs were removed from this app deliberately. Anything
  destructive should be confirmable in place.
- Removing from a setup and deleting from the library must be impossible to
  confuse. The second is the only irreversible action in the app.
- Mods that are required by another mod should be hard to delete by accident,
  and should say what would break.
- Handle the empty state: a new user has nothing here, and the screen should
  point at Browse or the drop target rather than showing a bare heading.
- One mod can belong to several setups, and some users will have a dozen
  setups. "Used by" needs to degrade gracefully from none to many.

### Notes

- Window chrome is the app's own: a 44px title strip carrying a breadcrumb
  (`GTArage › Library`) and the window buttons, with the nav on the right.
- Assume 1280×900, resizable, and that the content column can be as narrow as
  ~700px.
- Sizes are real: a script mod is ~2 MB, a texture pack can be 6 GB. The
  layout should not fall apart when one row says "5.9 GB" and the next says
  "180 KB".
