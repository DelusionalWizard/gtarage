# Design brief: Browse (rebuild)

Paste into Claude Design, in the same project as the existing mockups
(`f938fa3e-21bb-4b7e-9c6b-7166df262410`), so it inherits the 2a/2b language
and the conventions already set by Settings and Library.

The previous Browse has been deleted from the app entirely — tab, view, cards
and all. This is a rebuild from nothing, not a revision.

---

## Prompt

Design the **Browse** screen for **GTArage**, an open-source mod manager for
the Grand Theft Auto games (pronounced GTA + Garage). It sits in the app's
navigation beside Setups, Library, Backups and Settings.

Stay inside the established direction: warm paper ground, white cards,
hairline borders in the same warm family, Space Grotesk for names and prose,
JetBrains Mono for labels and anything compared character by character.
Exactly one saturated colour (the blue), reserved for the single action a
screen is asking for. Green means safe or done, orange means needs a decision.
Plain language throughout — the existing screens say "How it looks", never
"graphics kind". Design **light and dark**; in dark the emphatic surface is
the accent, never an inversion of the light idiom to white.

### Why the last one was deleted

The old Browse put a search box at the top and gave every result the same
card. That promised a catalogue of GTA mods that GTArage does not have and
will never have. People typed a mod name, got nothing, and concluded the app
was broken.

**The central design problem: Browse is not a store.** It is the place where
mods arrive, and they arrive by three genuinely unlike routes. The screen's
job is to make those three routes look as different as they behave, so nobody
has to try one to find out what it does.

### The three routes, and exactly what each can do

**1. A file you already have.** Drag in a `.zip`, `.rar` or `.oiv`, a folder,
or a loose `.asi`. GTArage reads it, works out what kind of mod it is and puts
it in the library. This always works, needs no network and no account, and is
how most mods actually get installed. It is currently the least prominent
thing on screen, which is backwards.

**2. Essentials — the short list GTArage installs itself.** Nine or so
load-bearing tools per game (ScriptHookV .NET, Packfile Limit Adjuster, Modkit
Limit Adjuster, an ASI loader, and so on) fetched from their **official GitHub
release pages**. Press a button, it downloads and lands in the library. This
is the only route with a real install button, and the list is short, fixed and
curated — it is not search results.

A few entries are marked *manual only*: their author does not publish a
downloadable release, so GTArage opens the page and the user brings the file
back. The design needs a resting state for "this one you have to fetch
yourself" that does not read as an error.

**3. Community sites — a handoff, not a listing.** GTA5-Mods, LibertyCity,
GTAinside and the rest have no public API, and **GTArage never scrapes them**.
All the app can do is open the site in a window, let the user log in and
download exactly as they normally would, and catch the resulting file into the
library. There is nothing to list, rank or search. This is a doorway.

### Hard constraints — please design to these, not around them

These are not preferences; they are what the app can actually populate.

- **No search across mods.** Nothing to search. A filter over the Essentials
  list is fine, since that list is on screen already.
- **No thumbnails, screenshots, ratings, download counts, author names,
  descriptions or "trending".** GTArage does not scrape, so it has none of it
  and never will. A card designed around a hero image will ship blank.
- **What actually exists per Essentials entry:** name, version string, one or
  more downloadable files with byte sizes, which file is the primary one, the
  project URL, and whether it is manual-only with a short reason.
- **Per-game.** Nine titles are supported and the Essentials list differs
  entirely between them. The screen is always showing one game.
- **Already-installed is a real state.** Many people will already have
  ScriptHookV. The entry must be able to say so and offer the update instead.
- **Installers are never run.** If a download turns out to be a `.exe`,
  GTArage saves it and refuses to execute it — deliberate, and it needs
  wording that reads as a safety decision rather than a failure.
- **Downloads are slow and visible.** A 300 MB file over a rate-limited host
  needs progress in place, and it must survive the user navigating away.

### States to draw

- Empty first run: no mods yet, nothing installed. This is most people's
  first look at the screen and should make route 1 obvious.
- An Essentials entry in each of: not installed, installed and current,
  installed but outdated, manual-only, downloading, failed.
- The moment a community-site download is caught, since it happens in a window
  that is covering the app.
- Offline, or GitHub unreachable. The Essentials list cannot load, but routes
  1 and 3 still work perfectly — the screen must not look dead.

### What good looks like

Someone who has never modded a GTA game opens this screen and understands,
without reading a paragraph, that there are three ways to get a mod, which one
applies to them, and what will happen when they press the thing. Someone who
has modded for years finds the drop target immediately and never reads the
rest.

Please produce the light and dark screens, the Essentials entry in each of its
states, and the empty first-run state.
