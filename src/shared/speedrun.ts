/**
 * Speedrunning mode.
 *
 * GTA V speedrunning has its own toolchain that has nothing to do with mods:
 * a downgrade launcher, a timer, a frame limiter, a capture program, and a
 * pile of community routing documents. None of it is something GTArage
 * should reimplement — LiveSplit is LiveSplit — but all of it is scattered
 * across a dozen bookmarks and install folders, and a mod manager already
 * knows where the game is.
 *
 * So this is a launcher and a directory, not a wrapper. GTArage finds the
 * tools you already have, starts them, and links the resources it cannot
 * install. It downloads nothing here: several of these are installers, and an
 * app that silently fetches and runs executables is exactly what people are
 * right to be suspicious of.
 */

import type { GameId } from './types';

/** Where a tool is usually installed, and how to describe it. */
export interface SpeedrunTool {
  id: string;
  name: string;
  summary: string;
  /** Absolute paths to probe, most likely first. */
  candidates: string[];
  /** Where to get it, when it is not installed. */
  url: string;
  /**
   * True when the tool is essential to running at all rather than a
   * convenience, so the UI can lead with it.
   */
  core?: boolean;
  /** Games it is relevant to. */
  games: GameId[];
}

/**
 * Project 127 deserves a note.
 *
 * It is an MIT-licensed open-source launcher (github.com/TwosHusbandS/Project-127)
 * that gets a legitimately owned GTA V to a working 1.27 state, which is the
 * version the Classic category is run on. It ships no game files and requires
 * an up-to-date install to start from. GTArage only detects and launches it;
 * it never downgrades anything itself.
 */
export const SPEEDRUN_TOOLS: SpeedrunTool[] = [
  {
    id: 'project127',
    name: 'Project 127',
    summary:
      'The launcher the Classic category is run on: takes a legitimately owned GTA V to a working 1.27 and launches it. Open source, MIT licensed.',
    candidates: [
      'C:/Program Files (x86)/Project 1.27/Project 127 Launcher.exe',
      'C:/Program Files/Project 1.27/Project 127 Launcher.exe',
    ],
    url: 'https://github.com/TwosHusbandS/Project-127',
    core: true,
    games: ['gta5'],
  },
  {
    id: 'livesplit',
    name: 'LiveSplit',
    summary:
      'The timer. Split files for every GTA V category are on speedrun.com, and the autosplitter is built in.',
    candidates: [
      'C:/Program Files/LiveSplit/LiveSplit.exe',
      'C:/Program Files (x86)/LiveSplit/LiveSplit.exe',
      'C:/LiveSplit/LiveSplit.exe',
    ],
    url: 'https://livesplit.org/downloads/',
    core: true,
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
  },
  {
    id: 'rtss',
    name: 'RivaTuner Statistics Server',
    summary:
      'Frame limiter. Several tricks depend on running at a specific framerate, and RTSS is how runs change it mid-run.',
    candidates: [
      'C:/Program Files (x86)/RivaTuner Statistics Server/RTSS.exe',
      'C:/Program Files/RivaTuner Statistics Server/RTSS.exe',
    ],
    url: 'https://www.guru3d.com/files-details/rtss-rivatuner-statistics-server-download.html',
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
  },
  {
    id: 'obs',
    name: 'OBS Studio',
    summary: 'Recording and streaming. Runs need video to be verified.',
    candidates: [
      'C:/Program Files/obs-studio/bin/64bit/obs64.exe',
      'C:/Program Files (x86)/obs-studio/bin/64bit/obs64.exe',
    ],
    url: 'https://obsproject.com/',
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
  },
  {
    id: 'autohotkey',
    name: 'AutoHotkey',
    summary:
      'Runs the community scripts, such as the one that allows jumping during mission pass screens. Project 127 bundles its own jump script.',
    candidates: [
      'C:/Program Files/AutoHotkey/v2/AutoHotkey64.exe',
      'C:/Program Files/AutoHotkey/AutoHotkey.exe',
      'C:/Program Files (x86)/AutoHotkey/AutoHotkey.exe',
    ],
    url: 'https://www.autohotkey.com/',
    games: ['gta5', 'gta5e', 'gta4', 'gtasa', 'gtavc', 'gta3'],
  },
];

/** A community document, video or download. Links only — nothing is fetched. */
export interface SpeedrunResource {
  name: string;
  url: string;
  note?: string;
  /** Needs membership of the GTA V speedrunning Discord to open. */
  discord?: boolean;
}

export interface ResourceGroup {
  title: string;
  blurb: string;
  items: SpeedrunResource[];
}

export const SPEEDRUN_RESOURCES: ResourceGroup[] = [
  {
    title: 'Guides and routing',
    blurb: 'Learn the route, then the individual segments.',
    items: [
      {
        name: 'Segment video guides',
        url: 'https://www.youtube.com/playlist?list=PLvTtES6sXkXG_llLthmP7AgKsXksz1f91',
      },
      {
        name: 'All Missions guide',
        url: 'https://docs.google.com/spreadsheets/d/1NL4z1OTCbElAqzElczziUk3N-iQ2B_RfTY5pFYTPp5Q/edit',
      },
      {
        name: 'Any% Classic community golds',
        url: 'https://docs.google.com/spreadsheets/d/1qDKZ_LGvPuLX1tSRUu4v7b63PmiP9RReqUUoic9irL0/',
        note: 'What a good split actually looks like, per segment.',
      },
      {
        name: 'Text wait spots',
        url: 'https://docs.google.com/document/d/1wCE1d-rtQGD8oLeioHOguZEOHBmMJHhUpNqjNMWhSY4/edit',
      },
      {
        name: 'Mission map',
        url: 'https://i.imgur.com/bXpRvuG.png',
      },
      {
        name: 'Texts and phone calls database',
        url: 'https://docs.google.com/spreadsheets/d/1_kPFFKgR0cfDOPQHotHsIr69YAd5I89dQ0jChZxcYuI/edit',
      },
      {
        name: 'Hospital map',
        url: 'https://imgur.com/6or5K0e',
      },
    ],
  },
  {
    title: 'Setup and patching',
    blurb: 'Getting the game to the right version and the right settings.',
    items: [
      {
        name: 'Project 127 installer',
        url: 'https://github.com/TwosHusbandS/Project-127',
        note: 'Linked to the project page rather than the direct installer, so you can see what you are running first.',
      },
      {
        name: 'In-game settings',
        url: 'https://www.youtube.com/watch?v=aVxiMiU67eg',
      },
      {
        name: 'Switching between copies of the game',
        url: 'https://www.youtube.com/watch?v=uGeDOYrW7n0',
        note: 'GTArage profiles cover much of this for mods; this covers whole game versions.',
      },
      {
        name: 'Changing FPS during a run',
        url: 'https://www.youtube.com/watch?v=C3St-kRlz18',
      },
    ],
  },
  {
    title: 'Timer and capture',
    blurb: 'LiveSplit setup, splits and layout.',
    items: [
      { name: 'LiveSplit downloads', url: 'https://livesplit.org/downloads/' },
      {
        name: 'GTA V split files',
        url: 'https://www.speedrun.com/gtav/resources',
      },
      {
        name: 'Autosplitter settings',
        url: 'https://i.imgur.com/2SA6fA8.png',
        note: 'The autosplitter ships with LiveSplit; this is how to configure it.',
      },
      {
        name: 'Transparent LiveSplit over the game',
        url: 'https://www.youtube.com/watch?v=-txlRCGM8C8',
      },
      { name: 'OBS Studio', url: 'https://obsproject.com/' },
    ],
  },
  {
    title: 'Practice mods',
    blurb:
      'Practice only — never in a submitted run. Install these into a separate profile so a single click puts the game back to clean.',
    items: [
      {
        name: 'Flashback',
        url: 'https://www.gta5-mods.com/scripts/flashback',
        note: 'Rewind to retry a segment without reloading.',
      },
      {
        name: 'Stunt jump landing zones',
        url: 'https://github.com/half-cambodian-hacker-man/StuntJumpPractice/releases/tag/2.0.0',
      },
      {
        name: 'Save file editor',
        url: 'https://x3t-infinity.com/GTA_V',
        note: 'Set up a specific game state to practise from.',
      },
      {
        name: 'Checkpoint changer, speedometer, modded RivaTuner',
        url: 'https://www.speedrun.com/gtav/forums',
        discord: true,
        note: 'Shared in the community Discord rather than published; ask there.',
      },
    ],
  },
];

/** Practice-only mods deserve their own profile, and this is its name. */
export const PRACTICE_PROFILE_NAME = 'Practice';
