/**
 * Add-on DLC pack awareness for GTA V.
 *
 * An add-on vehicle or map ships as a folder of RPF archives that goes under
 * `mods/update/x64/dlcpacks/<name>`. Copying it there is only half the job: the
 * game will not load it unless the pack is also listed in `dlclist.xml`, which
 * lives *inside* `update.rpf` and cannot be opened with Explorer.
 *
 * Miss that step and the mod installs perfectly, reports no error, and does
 * absolutely nothing. That is the same silent-failure class as a misclassified
 * ASI - the file lands somewhere plausible and the game simply never reads it -
 * which this project treats as a bug rather than as the user's mistake.
 *
 * GTArage does not write the entry. `dlclist.xml` sits inside an encrypted
 * archive, and shipping the means to decrypt it is a legal question rather than
 * an engineering one (see ROADMAP item 12). Detecting the gap needs none of
 * that, and detecting it is most of the value: the difference between "nothing
 * happened and I don't know why" and "one line is missing, here it is".
 */

/**
 * The path a DLC pack must be listed under, exactly as `dlclist.xml` wants it.
 *
 * The trailing slash and the `dlcpacks:/` scheme are both load-bearing. The
 * game matches this string literally, so a missing slash is a pack that does
 * not load, with no diagnostic anywhere.
 */
export function dlcListEntry(packName: string): string {
  return `dlcpacks:/${packName}/`;
}

/** The XML line to paste, which is what people actually need to be handed. */
export function dlcListLine(packName: string): string {
  return `<Item>${dlcListEntry(packName)}</Item>`;
}

/**
 * Pull the DLC pack names out of a mod's deploy targets.
 *
 * Matches the pack directory immediately under `dlcpacks/`, at any depth and
 * with or without a `mods/` prefix, because both `update/x64/dlcpacks/x` and
 * `mods/update/x64/dlcpacks/x` are real layouts depending on whether the
 * archive was authored for a mods folder.
 *
 * Names are returned lowercased: the game is case-insensitive here, and mod
 * authors are wildly inconsistent about it, so comparing raw would report a
 * missing entry for a pack that is in fact listed.
 */
export function dlcPacksIn(targets: string[]): string[] {
  const found = new Set<string>();
  for (const target of targets) {
    const match = target
      .replace(/\\/g, '/')
      .match(/(?:^|\/)dlcpacks\/([^/]+)/i);
    if (match?.[1]) found.add(match[1].toLowerCase());
  }
  return [...found];
}

/**
 * The pack names already listed in a `dlclist.xml`.
 *
 * Parsed with a regex rather than an XML parser on purpose: this file is read
 * to answer one yes/no question, it is frequently hand-edited into a state a
 * strict parser would reject, and refusing to answer because someone left a
 * stray ampersand in a comment would be worse than useless.
 */
export function listedPacks(xml: string): string[] {
  const found = new Set<string>();
  for (const match of xml.matchAll(/dlcpacks:\/+([^<>\s/]+)/gi)) {
    if (match[1]) found.add(match[1].toLowerCase());
  }
  return [...found];
}

export interface DlcGap {
  /** The pack folder the mod installed. */
  pack: string;
  /** The line that needs to exist in dlclist.xml. */
  line: string;
}

/**
 * Packs a mod installs that nothing has listed.
 *
 * When `xml` is null the file could not be read - it is inside update.rpf and
 * we have no RPF reader - so every pack is reported as unconfirmed. That is
 * the honest answer, and the UI wording has to reflect it: "this needs a
 * dlclist entry" rather than "this entry is missing", because on a setup where
 * the user already added it by hand the second sentence would be a lie.
 */
export function dlcGaps(targets: string[], xml: string | null): DlcGap[] {
  const packs = dlcPacksIn(targets);
  if (packs.length === 0) return [];
  const listed = new Set(xml === null ? [] : listedPacks(xml));
  return packs
    .filter((pack) => !listed.has(pack))
    .map((pack) => ({ pack, line: dlcListLine(pack) }));
}

/**
 * How many add-on packs a set of mods installs between them.
 *
 * Drives the gameconfig suggestion (ROADMAP item 8). Add-on packs consume
 * fixed-size memory pools, and past a certain count the game crashes on load
 * with nothing to indicate that the pools are the reason. The replacement
 * `gameconfig.xml` that raises those limits is already in the catalogue; it was
 * simply never connected to the situation that calls for it.
 */
export function countPacks(targetsPerMod: string[][]): number {
  const all = new Set<string>();
  for (const targets of targetsPerMod) {
    for (const pack of dlcPacksIn(targets)) all.add(pack);
  }
  return all.size;
}

/**
 * The point at which raising the memory pools starts to matter.
 *
 * Deliberately not 1. The stock pools handle a handful of add-ons without
 * complaint, and a manager that demanded a gameconfig replacement for a single
 * add-on car would be crying wolf - which trains people to ignore it by the
 * time it is real.
 */
export const GAMECONFIG_THRESHOLD = 8;

export function needsGameconfig(packCount: number): boolean {
  return packCount >= GAMECONFIG_THRESHOLD;
}
