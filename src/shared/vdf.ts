/**
 * Just enough Valve KeyValues (VDF) to edit one field safely.
 *
 * `localconfig.vdf` holds every Steam launch option the user has ever set,
 * for every game, alongside a great deal else. Writing into it with a regex
 * is how you corrupt somebody's Steam configuration: the file nests, keys
 * repeat at different depths, and `"LaunchOptions"` appears once per app that
 * has any. So this parses to a tree and re-serialises, which means an edit
 * cannot land in the wrong app's block.
 *
 * Deliberately small. It handles the subset the file actually uses -- quoted
 * keys, quoted values, nested braces, and `//` comments outside strings --
 * and nothing else. Binary VDF and macros are not supported, and no Steam
 * config file this touches uses them.
 */

export interface VdfNode {
  [key: string]: string | VdfNode;
}

class Reader {
  private i = 0;

  constructor(private readonly src: string) {}

  atEnd(): boolean {
    this.skipTrivia();
    return this.i >= this.src.length;
  }

  peek(): string {
    this.skipTrivia();
    return this.src[this.i] ?? '';
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.src[this.i];
      if (ch === undefined) return;
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.i += 1;
        continue;
      }
      // Comments run to end of line. Only ever seen outside strings.
      if (ch === '/' && this.src[this.i + 1] === '/') {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i += 1;
        continue;
      }
      return;
    }
  }

  take(ch: string): void {
    this.skipTrivia();
    if (this.src[this.i] !== ch) {
      throw new Error(`Expected ${ch} at offset ${this.i}`);
    }
    this.i += 1;
  }

  /** A quoted token, with the escapes Valve actually emits. */
  readString(): string {
    this.skipTrivia();
    if (this.src[this.i] !== '"') throw new Error(`Expected a string at offset ${this.i}`);
    this.i += 1;
    let out = '';
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else out += next ?? '';
        this.i += 2;
        continue;
      }
      if (ch === '"') {
        this.i += 1;
        return out;
      }
      out += ch;
      this.i += 1;
    }
    throw new Error('Unterminated string');
  }
}

function parseBody(r: Reader, top: boolean): VdfNode {
  const node: VdfNode = {};
  for (;;) {
    if (top ? r.atEnd() : r.peek() === '}') break;
    if (r.atEnd()) break;
    const key = r.readString();
    if (r.peek() === '{') {
      r.take('{');
      node[key] = parseBody(r, false);
      r.take('}');
    } else {
      node[key] = r.readString();
    }
  }
  return node;
}

export function parseVdf(text: string): VdfNode {
  return parseBody(new Reader(text), true);
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function stringifyVdf(node: VdfNode, indent = 0): string {
  const pad = '\t'.repeat(indent);
  let out = '';
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      out += `${pad}"${escape(key)}"\t\t"${escape(value)}"\n`;
    } else {
      out += `${pad}"${escape(key)}"\n${pad}{\n${stringifyVdf(value, indent + 1)}${pad}}\n`;
    }
  }
  return out;
}

/**
 * Follow a path of keys, matching case-insensitively.
 *
 * Steam is inconsistent about capitalisation across versions -- `apps` and
 * `Apps` both occur in the wild, as do `Software`/`software` -- so an exact
 * lookup silently fails to find a block that is right there, and the caller
 * concludes the app has no entry and creates a duplicate one.
 */
export function vdfGet(node: VdfNode, keys: string[]): VdfNode | string | undefined {
  let current: VdfNode | string | undefined = node;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    const here: VdfNode = current;
    const found = Object.keys(here).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found === undefined) return undefined;
    current = here[found];
  }
  return current;
}

/** Like `vdfGet`, but creates missing levels so a value can be written. */
export function vdfEnsure(node: VdfNode, keys: string[]): VdfNode {
  let current = node;
  for (const key of keys) {
    const found = Object.keys(current).find((k) => k.toLowerCase() === key.toLowerCase());
    const next = found === undefined ? undefined : current[found];
    if (typeof next === 'object' && next !== null) {
      current = next;
    } else {
      const fresh: VdfNode = {};
      current[found ?? key] = fresh;
      current = fresh;
    }
  }
  return current;
}
