# Design brief: feature video

Paste into Claude Design, in the same project as the GTArage mockups
(`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so the frames are drawn in the app's
real visual language rather than a fresh one.

**On the medium:** Claude Design produces HTML documents, not video files. Ask
it for a **storyboard**: one frame per shot, drawn in the real UI, with the
on-screen action and the narration line beneath each. That is the thing you
then record or animate. Asking for "a video" directly gets you a web page
pretending to be one.

**Written against 1.0.0.** Every screen named here exists and is shipped. The
previous version of this brief predated the Tools rebuild and told the designer
*not* to draw that tab — if any of this stops matching the app, fix the brief
before drawing, because a storyboard is believed.

---

## Prompt

Design a **storyboard for a short feature video** introducing **GTArage**
(pronounced GTA + Garage), a free, open-source mod manager for the Grand Theft
Auto games. Two to three minutes, roughly 14–18 shots.

Draw every frame in GTArage's existing visual language — warm paper ground,
white cards, Space Grotesk and JetBrains Mono, a single blue accent — and use
the **real screens** from this project rather than inventing new ones. A frame
showing something the app cannot do is worse than no frame.

For each shot give me: the frame, a one-line description of the motion or
interaction, and the narration line. Keep narration plain and short. The app
says "How it looks", never "graphics customisation", and the video should sound
like the app.

### The story

Open on the problem, not the product. Someone has mods installed, wants to play
online safely, wants a different set for a different mood, and today that means
moving files by hand and hoping.

Then, in this order:

1. **Setups.** The home screen asks "Which setup do you want to play?" One card
   per setup. Show the two-press flow that the whole app turns on: **"Switch to
   Chaos"** installs that setup and stops — then the button becomes **Play
   now**. Once the game is running the card offers **Launch another instance**.
   Three states, and the video should let each land.
2. **The swap summary.** Before anything moves, the panel shows exactly what
   the next press will add, remove and keep. This is the single best argument
   for the app — that nothing changes until you press Play — so give it a
   proper beat rather than folding it into the shot above.
3. **What's in a setup.** Plain-language switches, each with a sentence saying
   what it does. Drag a mod by its grip to reorder; later wins.
4. **Conflicts, explained rather than reported.** Two mods want the same file.
   The panel names both, names the winner, gives the rule, and offers to flip
   it.
5. **Per-file control.** Open a mod's ⋯ menu and switch off one file inside it
   without removing the mod — the usual case being a config you have already
   tuned by hand.
6. **The vanilla lock.** A setup that installs nothing, for going online. No
   switches, no setup screen, one Play Now button, by design. This is the
   safety story and deserves its own beat.
7. **Nothing is ever deleted.** Saves are snapshotted before every switch, and
   any game file a mod overwrites is shelved and put back — including a whole
   folder a mod brought with it.
8. **Library.** Everything you own, which setups use it, what nothing is using.
   Adding a mod to a second setup copies nothing. When a mod is missing a
   prerequisite, the Library says so and can fetch that one tool.
9. **Tools.** Where mods come from, and the honest framing matters here: there
   is no catalogue and no search. Show the **Essentials** list — real install
   buttons, and rows that say where you stand: up to date, an update available,
   manual only, could not check. Then the **community sites** column, which is
   a doorway: GTArage opens the site, you log in and download normally, and it
   catches the file.
10. **First launch.** The one prompt that appears unasked: install the tools
    mods rely on, and start from a clean game folder.
11. **It notices when the game updates.** After a patch, GTArage compares the
    build and names the mods that have probably stopped loading, instead of
    leaving someone to discover it by crashing on load.
12. **Settings**, briefly — the safety options grouped first, links versus
    copies explained, and the **Disable BattlEye** button for GTA V Enhanced
    with its story-mode-only warning.
13. Close on what it is: free, open source, MIT, works across the GTA titles.

### Be accurate

This is the part that matters most.

- **The navigation reads Setups · Tools · Library · Backups · Settings.** Five
  items, in that order.
- **There is no search over mods anywhere**, and no ratings, download counts,
  screenshots or author names. GTArage does not scrape mod sites, so it has
  none of that data. A frame implying a storefront misrepresents the whole
  product.
- **There is no Nexus API integration.** Nexus appears only as a site you open
  and download from by hand.
- **Tools has no drop target on it.** Dragging a file in works anywhere in the
  window, but the Tools screen does not advertise it — do not draw a dashed
  drop zone there.
- **The Definitive Editions are supported but have never been confirmed loading
  a real mod in-game.** Do not imply otherwise. Same for launching an Epic
  copy: implemented, never exercised on real hardware.
- **The builds are unsigned.** If the closing frame makes any claim about
  safety, make it the true one: nothing is deleted, everything displaced is
  recoverable.
- Sizes should be realistic — a script mod is a couple of MB, a texture pack
  can be 6 GB.
- **Modding online gets accounts banned.** Wherever that is said, it must be
  said as the real reason the vanilla lock exists, not as legal cover.

### Craft notes

- Frames are 1280×900, matching the app.
- Light theme throughout for legibility, but include **one dark frame** so
  viewers know it exists.
- Motion should be small and purposeful: a switch flipping, a card becoming the
  active one, a list reordering, a button moving from Switch to Play now. No
  sweeping transitions.
- Where a shot needs a caption over the UI, design that caption — do not leave
  it to whoever records it.
- The opening and closing frames are the only ones that may depart from the app
  chrome.

Please produce the frames in order, each with its action line and narration,
plus a one-line note on which real screen it is drawn from.
