# Design brief: feature video

Paste into Claude Design, in the same project as the GTArage mockups
(`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so the frames are drawn in the app's
real visual language rather than a fresh one.

**On the medium:** Claude Design produces HTML documents, not video files. Ask
it for a **storyboard**: one frame per shot, in the real UI, with the on-screen
action and the narration line beneath each. That is the thing you then record
or animate. Asking for "a video" directly gets you a web page pretending to be
one.

---

## Prompt

Design a **storyboard for a short feature video** introducing **GTArage**, an
open-source mod manager for the Grand Theft Auto games. Target two to three
minutes, roughly 14–18 shots.

Draw every frame in GTArage's existing visual language — the same warm paper
ground, white cards, Space Grotesk and JetBrains Mono, single blue accent — and
use the **real screens** from this project rather than inventing new ones. A
frame that shows something the app cannot do is worse than no frame.

For each shot give me: the frame itself, a one-line description of the motion
or interaction, and the narration line. Keep narration plain and short — the
app's own copy says "How it looks", never "graphics kind", and the video should
sound like the app.

### The story it should tell

Open on the problem, not the product. Someone has mods installed, wants to
play online safely, wants a different set for a different mood, and today that
means moving files by hand and hoping.

Then, in this order:

1. **Setups.** The home screen asks "Which setup do you want to play?" One card
   per setup, one button. Show switching from one to another and the button
   moving Switch and play → Play now → Running.
2. **A setup's contents.** Plain-language on/off switches, each with a sentence
   saying what it does. Nothing changes in the game until you press Play.
3. **Conflicts, explained rather than reported.** Two mods want the same file;
   the panel names which one is winning and why, and offers to flip it.
4. **Load order.** Drag to reorder; later wins.
5. **The vanilla lock.** A setup that installs nothing, for going online. This
   is the safety story and deserves its own beat.
6. **Your saves are copied before every switch**, and nothing is ever deleted —
   files a mod displaces are shelved and put back.
7. **Library.** Everything you own, which setups use it, and what nothing is
   using. Adding a mod to a second setup does not download or copy it again.
8. **Browse.** Three ways a mod arrives: a file you already have, the
   essentials GTArage installs itself, and community sites where it opens the
   page and catches your download.
9. **Settings**, briefly — the safety options grouped first, and the
   explanation of links versus copies.
10. Close on what it is: free, open source, and works across the GTA titles.

### Be accurate

This is the part that matters most. The video will be believed.

- **Do not show features that exist only in the code.** Per-file toggles, the
  game-update alert and the dlclist warning are all implemented but not
  currently reachable in the interface. Leave them out.
- **The Definitive Editions are supported but untested with mods.** Do not
  imply otherwise.
- GTArage **never scrapes** the community sites, and there is no Nexus
  account integration. The browser handoff is the whole mechanism.
- The builds are **unsigned**, and it is **beta**. If the closing frame makes
  any claim about safety, it should be the true one: nothing is deleted,
  everything displaced is recoverable.
- Sizes should be realistic — a script mod is a couple of MB, a texture pack
  can be 6 GB.

### Craft notes

- Frames are 1280×900, matching the app.
- Assume light theme throughout for legibility, but include **one dark frame**
  so viewers know it exists.
- Motion should be small and purposeful: a switch flipping, a card becoming
  the active one, a list reordering. No sweeping transitions.
- Where a shot needs a caption on top of the UI, design that caption — do not
  leave it to whoever records it.
- The opening and closing frames are the only ones that may depart from the app
  chrome.
