# Design brief: feature video

Paste into Claude Design, in the same project as the GTArage mockups
(`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so the frames are drawn in the app's
real visual language rather than a fresh one.

**On the medium:** Claude Design produces HTML documents, not video files. Ask
it for a **storyboard**: one frame per shot, in the real UI, with the on-screen
action and the narration line beneath each. That is the thing you then record
or animate. Asking for "a video" directly gets you a web page pretending to be
one.

**Currency:** rewritten after the GTArage rename, after Browse was removed
pending a rebuild, and after per-file toggles, the game-update alert and the
dlclist warning all became reachable in the interface. If Browse has been
rebuilt by the time you read this, add it back as a beat between Library and
Settings and describe it from the rebuilt screen, not from memory.

---

## Prompt

Design a **storyboard for a short feature video** introducing **GTArage**
(pronounced GTA + Garage), an open-source mod manager for the Grand Theft Auto
games. Target two to three minutes, roughly 14–18 shots.

Draw every frame in GTArage's existing visual language — the same warm paper
ground, white cards, Space Grotesk and JetBrains Mono, single blue accent — and
use the **real screens** from this project rather than inventing new ones. A
frame that shows something the app cannot do is worse than no frame.

For each shot give me: the frame itself, a one-line description of the motion
or interaction, and the narration line. Keep narration plain and short — the
app's own copy says "How it looks", never "graphics kind", and the video should
sound like the app.

### The story it should tell

Open on the problem, not the product. Someone has mods installed, wants to play
online safely, wants a different set for a different mood, and today that means
moving files by hand and hoping.

Then, in this order:

1. **Setups.** The home screen asks "Which setup do you want to play?" One card
   per setup, one button. Show switching from one setup to another, and the
   button moving **Switch and play → Play now → Running**. Once the game is
   running the card also offers **Launch another instance**.
2. **A setup's contents.** Plain-language on/off switches, each with a sentence
   saying what it does. Nothing changes in the game until you press Play — and
   the panel shows a live summary of exactly what the next press will add,
   remove and keep. That preview is the single best argument for the app;
   give it a proper beat.
3. **Reordering, in place.** The order lives on the setup screen itself — drag
   a mod by its grip and later wins. There is no separate load-order screen.
4. **Conflicts, explained rather than reported.** Two mods want the same file;
   the panel names which one is winning and why, and offers to flip it.
5. **Per-file control.** Open a mod's ⋯ menu and switch off one file inside it
   without removing the mod — the usual case being a mod that ships a config
   you have already tuned by hand.
6. **The vanilla lock.** A setup that installs nothing, for going online. It
   has no setup screen and no switches at all — one Play Now button, by design.
   This is the safety story and deserves its own beat.
7. **Your saves are copied before every switch**, and nothing is ever deleted —
   files a mod displaces are shelved and put back, and a whole folder a mod
   brought with it moves to the shelf intact.
8. **Library.** Everything you own, which setups use it, and what nothing is
   using. Adding a mod to a second setup does not download or copy it again.
   When a mod needs a prerequisite it does not have, the Library says so and
   can fetch that one tool from its official release page.
9. **It notices when the game updates.** After a patch, GTArage compares the
   new build against the mods that care and says which ones are likely broken
   — rather than leaving someone to discover it by crashing on load.
10. **Settings**, briefly — the safety options grouped first, and the
    explanation of links versus copies.
11. Close on what it is: free, open source, and works across the GTA titles.

### Be accurate

This is the part that matters most. The video will be believed.

- **There is no Browse screen right now.** It was removed and is being
  rebuilt, so nothing may imply an in-app catalogue, search, or a mod store.
  Mods arrive by dragging a file in, or via the Library's prerequisite
  installer. Do not draw a Browse tab in the navigation: it reads
  **Setups · Library · Backups · Settings**.
- **GTArage never scrapes mod sites**, and there is no Nexus account
  integration. Do not show ratings, download counts, screenshots or author
  names anywhere — the app has none of that data.
- The features that were previously off-limits are now fair game and **should**
  be shown: per-file toggles, the game-update alert, and the dlclist warning
  for add-on packs that are installed but not listed.
- **The Definitive Editions are supported but untested with mods.** Do not
  imply otherwise.
- The builds are **unsigned**, and it is **beta**. If the closing frame makes
  any claim about safety, it should be the true one: nothing is deleted,
  everything displaced is recoverable.
- Sizes should be realistic — a script mod is a couple of MB, a texture pack
  can be 6 GB.

### Craft notes

- Frames are 1280×900, matching the app.
- Assume light theme throughout for legibility, but include **one dark frame**
  so viewers know it exists.
- Motion should be small and purposeful: a switch flipping, a card becoming the
  active one, a list reordering. No sweeping transitions.
- Where a shot needs a caption on top of the UI, design that caption — do not
  leave it to whoever records it.
- The opening and closing frames are the only ones that may depart from the app
  chrome.
