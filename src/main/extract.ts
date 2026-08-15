/**
 * Archive extraction, with a fallback to whatever the user already has.
 *
 * The built-in reader in `zip.ts` handles ordinary ZIPs (and therefore `.oiv`
 * packages) with no dependencies, which covers most mods. It deliberately
 * refuses ZIP64 and encrypted entries rather than producing a half-extracted
 * mod.
 *
 * That leaves real gaps: `.rar` and `.7z` are common on the older mod sites,
 * and very large texture packs do exceed the classic ZIP limits. Rather than
 * bundle an extractor (and its licence), Swapmeet looks for 7-Zip or WinRAR --
 * which anyone downloading `.rar` mods already has -- and shells out to it.
 * If neither is present the user gets a message naming the actual problem.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureDir } from './fsutil';
import { extractZip } from './zip';

const execFileAsync = promisify(execFile);

/** Archives the built-in reader handles. */
const NATIVE_ZIP = /\.(zip|oiv)$/i;
/** Archives that always need an external tool. */
const NEEDS_TOOL = /\.(rar|7z|tar|gz|bz2|xz)$/i;

export function isArchive(file: string): boolean {
  return NATIVE_ZIP.test(file) || NEEDS_TOOL.test(file);
}

/** Candidate locations for a command-line extractor. */
const TOOL_CANDIDATES: Array<{ exe: string; args: (archive: string, dest: string) => string[] }> = [
  {
    exe: 'C:/Program Files/7-Zip/7z.exe',
    args: (a, d) => ['x', a, `-o${d}`, '-y', '-bd'],
  },
  {
    exe: 'C:/Program Files (x86)/7-Zip/7z.exe',
    args: (a, d) => ['x', a, `-o${d}`, '-y', '-bd'],
  },
  {
    exe: 'C:/Program Files/WinRAR/UnRAR.exe',
    args: (a, d) => ['x', '-y', a, `${d}/`],
  },
  {
    exe: 'C:/Program Files/WinRAR/WinRAR.exe',
    args: (a, d) => ['x', '-y', a, `${d}/`],
  },
  // Whatever is on PATH, including 7z on Linux/macOS.
  { exe: '7z', args: (a, d) => ['x', a, `-o${d}`, '-y', '-bd'] },
  { exe: '7za', args: (a, d) => ['x', a, `-o${d}`, '-y', '-bd'] },
];

let cachedTool: (typeof TOOL_CANDIDATES)[number] | null | undefined;

/** Find an extractor once per session. */
async function findTool(): Promise<(typeof TOOL_CANDIDATES)[number] | null> {
  if (cachedTool !== undefined) return cachedTool;

  for (const candidate of TOOL_CANDIDATES) {
    try {
      if (candidate.exe.includes('/')) {
        await fs.access(candidate.exe);
      } else {
        // Bare command: probe it. 7-Zip exits non-zero for a bare invocation,
        // so reaching the catch-free path at all means it exists.
        await execFileAsync(candidate.exe, ['i'], { timeout: 8000 }).catch((err) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
        });
      }
      cachedTool = candidate;
      return cachedTool;
    } catch {
      // try the next one
    }
  }

  cachedTool = null;
  return null;
}

/** True when an external extractor is available, for the UI to mention. */
export async function hasExternalExtractor(): Promise<boolean> {
  return (await findTool()) !== null;
}

async function extractWithTool(archivePath: string, destDir: string): Promise<void> {
  const tool = await findTool();
  const ext = path.extname(archivePath).toLowerCase();

  if (!tool) {
    throw new Error(
      `${ext} archives need 7-Zip or WinRAR, and neither was found. Install 7-Zip (7-zip.org), or extract the archive yourself and use "Add mod folder".`,
    );
  }

  await ensureDir(destDir);
  try {
    await execFileAsync(tool.exe, tool.args(archivePath, destDir), {
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `${path.basename(archivePath)} could not be extracted: ${(err as Error).message}`,
    );
  }
}

/**
 * Whether a built-in-reader failure is worth retrying with an external tool.
 *
 * Retryable means "this archive is fine, our reader is limited": ZIP64 and
 * unsupported compression methods. Everything else -- a traversal attempt, an
 * encrypted archive, a damaged file -- is a real answer and must be reported,
 * not routed around.
 */
function isRetryable(err: unknown): boolean {
  if ((err as NodeJS.ErrnoException)?.code === 'ERR_UNSAFE_PATH') return false;
  const message = (err as Error)?.message ?? '';
  if (/password-protected/i.test(message)) return false;
  if (/damaged zip/i.test(message)) return false;
  return /zip64|unsupported compression/i.test(message);
}

/**
 * Extract any supported archive into `destDir`.
 *
 * ZIPs go through the built-in reader first. When that refuses -- ZIP64, an
 * unsupported compression method -- we retry with an external tool before
 * giving up, so a big archive is not rejected just because our reader is
 * intentionally simple.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (NATIVE_ZIP.test(archivePath)) {
    try {
      await extractZip(archivePath, destDir);
      return;
    } catch (err) {
      // Only retry when the built-in reader was merely too simple. A refusal
      // to write outside the destination is a security decision, and handing
      // that same archive to 7-Zip would delegate the containment guarantee
      // to a third-party tool -- exactly the bypass safeJoin exists to stop.
      if (!isRetryable(err)) throw err;
      if (!(await hasExternalExtractor())) throw err;
      // Clear whatever the failed attempt left behind before retrying.
      await fs.rm(destDir, { recursive: true, force: true });
      await extractWithTool(archivePath, destDir);
      return;
    }
  }

  await extractWithTool(archivePath, destDir);
}
