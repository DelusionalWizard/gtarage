/**
 * Reading OpenIV `.oiv` packages.
 *
 * An `.oiv` is a ZIP with an `assembly.xml` inside, and the important thing
 * about it is that it is **a script, not a file tree**. The XML lists
 * operations: copy this file to that path, add this line to that XML, replace
 * this entry *inside* an RPF archive. Unpacking the archive and copying what
 * falls out is not installing it — that was what GTArage did, and for any
 * package that edits an archive it produced a mod that deployed cleanly and
 * changed nothing in the game.
 *
 * GTArage cannot write into RPF archives. They are a proprietary, encrypted
 * container, and shipping the means to open them is a legal question rather
 * than an engineering one — the same wall the dlclist work stopped at.
 *
 * So the honest design is: read the script, say exactly what it would do,
 * carry out the part that is ordinary file copying, and hand the rest to
 * OpenIV rather than silently doing nothing. A package that needs OpenIV
 * should say so before it is installed, not after the game fails to change.
 *
 * Parsed with regexes rather than an XML parser, for the same reason
 * `dlcpacks.ts` is: these files are hand-edited by mod authors, frequently
 * into a state a strict parser rejects, and refusing to describe a package
 * because of a stray ampersand would be worse than useless.
 */

/** What an `.oiv` says about itself. */
export interface OivMetadata {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
}

/** One thing a package would do. */
export interface OivOperation {
  /**
   * `copy` lands a file in the game folder, which GTArage can do.
   * `archive` edits the inside of an RPF, which it cannot.
   * `xml` edits an XML file in place, which it does not attempt either:
   * the targets normally live inside an archive.
   */
  kind: 'copy' | 'archive' | 'xml' | 'delete';
  /** Where it applies, as written in the package. */
  target: string;
  /** Source path inside the package, for copies. */
  source?: string;
}

export interface OivPackage {
  metadata: OivMetadata;
  operations: OivOperation[];
}

function textOf(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  if (!match?.[1]) return undefined;
  const value = match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
  return value || undefined;
}

export function parseOivMetadata(xml: string): OivMetadata {
  const meta: OivMetadata = {};
  const name = textOf(xml, 'name');
  const version = textOf(xml, 'version');
  const author = textOf(xml, 'author');
  const description = textOf(xml, 'description');
  if (name) meta.name = name;
  if (version) meta.version = version;
  if (author) meta.author = author;
  if (description) meta.description = description;
  return meta;
}

/**
 * The operations a package performs.
 *
 * `<archive>` blocks are the ones that matter for the verdict: their contents
 * are written inside an RPF. Anything nested under one is therefore an archive
 * edit no matter what element it is, which is why the archive spans are
 * removed from the text before the plain copies are matched — otherwise a
 * `<add>` inside an archive would be counted as a file GTArage can place.
 */
export function parseOivOperations(xml: string): OivOperation[] {
  const ops: OivOperation[] = [];

  // Archive edits, and everything inside them.
  const archiveSpans: Array<[number, number]> = [];
  const archiveRe = /<archive\b[^>]*\bpath\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/archive>/gi;
  for (const match of xml.matchAll(archiveRe)) {
    if (match.index !== undefined) {
      archiveSpans.push([match.index, match.index + match[0].length]);
    }
    ops.push({ kind: 'archive', target: match[1] ?? '' });
  }

  // Self-closing archive elements carry a path but no body.
  for (const match of xml.matchAll(/<archive\b[^>]*\bpath\s*=\s*"([^"]*)"[^>]*\/>/gi)) {
    ops.push({ kind: 'archive', target: match[1] ?? '' });
  }

  const outsideArchive = (index: number): boolean =>
    !archiveSpans.some(([start, end]) => index >= start && index < end);

  // Plain file placement. OpenIV writes these as <add source="...">path</add>.
  for (const match of xml.matchAll(
    /<add\b[^>]*\bsource\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/add>/gi,
  )) {
    if (match.index === undefined || !outsideArchive(match.index)) continue;
    const target = (match[2] ?? '').replace(/<[^>]+>/g, '').trim();
    ops.push({ kind: 'copy', target, source: match[1] ?? '' });
  }

  for (const match of xml.matchAll(/<delete\b[^>]*>([\s\S]*?)<\/delete>/gi)) {
    if (match.index === undefined || !outsideArchive(match.index)) continue;
    const target = (match[1] ?? '').replace(/<[^>]+>/g, '').trim();
    if (target) ops.push({ kind: 'delete', target });
  }

  // XML edits outside an archive are rare but real (a loose settings file).
  for (const match of xml.matchAll(/<xml\b[^>]*\bpath\s*=\s*"([^"]*)"[^>]*>/gi)) {
    if (match.index === undefined || !outsideArchive(match.index)) continue;
    ops.push({ kind: 'xml', target: match[1] ?? '' });
  }

  return ops;
}

export function parseOiv(xml: string): OivPackage {
  return { metadata: parseOivMetadata(xml), operations: parseOivOperations(xml) };
}

export interface OivVerdict {
  /** Operations GTArage can carry out itself. */
  copies: OivOperation[];
  /** Operations that need OpenIV, because they write inside an archive. */
  needsOpenIv: OivOperation[];
  /**
   * True when nothing in the package can be applied by GTArage. Installing it
   * would produce a mod that deploys cleanly and changes nothing, which is the
   * failure this whole module exists to prevent.
   */
  handOff: boolean;
  /** The distinct archives it would edit, for saying so out loud. */
  archives: string[];
}

export function oivVerdict(pkg: OivPackage): OivVerdict {
  const copies = pkg.operations.filter((op) => op.kind === 'copy');
  const needsOpenIv = pkg.operations.filter(
    (op) => op.kind === 'archive' || op.kind === 'xml',
  );
  const archives = [...new Set(needsOpenIv.map((op) => op.target).filter(Boolean))];
  return {
    copies,
    needsOpenIv,
    handOff: copies.length === 0 && needsOpenIv.length > 0,
    archives,
  };
}

/** A sentence for the UI, in the app's own register. */
export function describeOiv(verdict: OivVerdict): string {
  if (verdict.needsOpenIv.length === 0) {
    return verdict.copies.length > 0
      ? `This package only copies files in, so GTArage can install it like any other mod.`
      : `This package does not appear to change anything GTArage can act on.`;
  }
  const archives =
    verdict.archives.length > 0
      ? ` It edits ${verdict.archives.length} game archive${verdict.archives.length === 1 ? '' : 's'}.`
      : '';
  if (verdict.handOff) {
    return `Everything this package does happens inside the game's own archives, which GTArage cannot open.${archives} Install it with OpenIV instead — nothing here can be applied on its own.`;
  }
  return `GTArage can place ${verdict.copies.length} file${verdict.copies.length === 1 ? '' : 's'} from this package, but the rest happens inside the game's own archives, which it cannot open.${archives} Use OpenIV for the remainder, or the mod will be only partly installed.`;
}
