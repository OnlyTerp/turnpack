import fs from "node:fs";
import path from "node:path";
import { expandShortNames } from "../security.js";
import { rangesContain, type LineRange } from "./line-diff.js";

/**
 * Points a failing check at the part of the change it is about.
 *
 * Test runners, compilers and linters name the file and line they choke on. When that file is
 * one this call changed, the reply says so, and says whether the line is one the call wrote.
 * A failure inside the lines the model just wrote is almost always its own edit; a failure
 * elsewhere in a changed file, or in no changed file at all, usually means a caller or a test
 * that the change did not account for. Both are worth knowing before the next attempt.
 */

export interface BlameFile {
  relPath: string;
  /** Set when the call removed the file from this path. */
  gone?: "deleted" | "moved";
  /** Lines of the new file that the call changed; null when that could not be worked out. */
  ranges: LineRange[] | null;
  /**
   * The file as the check saw it, given when the call is being rolled back. The lines a failure
   * names are then quoted in the reply, because once the file is back as it was they are no
   * longer on disk, and its line numbers no longer line up with the ones in the output.
   */
  text?: string;
}

const MAX_LINES_PER_FILE = 4;
const MAX_MENTIONS = 8;
const MAX_OTHERS = 3;
const MAX_QUOTED = 6;
const MAX_QUOTED_CHARS = 160;
const MAX_CANDIDATES = 200;

/**
 * file:///home/x or file:///C:/x as a plain path. Node names a failing ES module this way, with
 * a space in the path written %20 and a tilde %7E, so the escapes are decoded too.
 */
function plainPaths(output: string): string {
  return output.replace(/file:\/\/(?:\/(?=[A-Za-z]:))?([^\s"'`<>]*)/g, (_whole, rest: string) => {
    try {
      return decodeURIComponent(rest);
    } catch {
      return rest;
    }
  });
}

/**
 * The ways the workspace root can be spelled in a command's output: as the command was given
 * it, with links resolved, and on Windows with short names (RUNNER~1) written out.
 */
function rootSpellings(workspaceRoot: string): string[] {
  const given = path.resolve(workspaceRoot);
  const spellings = new Set<string>([given, expandShortNames(given)]);
  try {
    spellings.add(fs.realpathSync.native(given));
  } catch {
    // A root that is gone has no other spelling.
  }
  // macOS keeps /var, /tmp and /etc under /private and prints either.
  for (const spelling of [...spellings]) {
    if (spelling.startsWith("/private/")) spellings.add(spelling.slice("/private".length));
  }
  return [...spellings].sort((a, b) => b.length - a.length);
}

/**
 * The output with file URLs made plain and the workspace root, however it is spelled, written
 * as "./", so one pattern finds a file named by a relative path, an absolute one or a URL. A
 * longer path that merely ends like the root is another folder and is left as it is.
 */
function relativeToRoot(output: string, workspaceRoot: string): string {
  let text = plainPaths(output);
  const flags = process.platform === "win32" ? "gi" : "g";
  for (const spelling of rootSpellings(workspaceRoot)) {
    text = text.replace(new RegExp(`(?<![\\w.\\-~])${pathPattern(spelling)}[\\\\/]+`, flags), "./");
  }
  return text;
}

/**
 * Files of the workspace that the failing output names with a line number, other than the ones
 * this call changed: usually a caller or a test that the change has not caught up with.
 * `text` is the output after relativeToRoot.
 */
function otherFiles(text: string, changed: BlameFile[], workspaceRoot: string): string[] {
  const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const skip = new Set(changed.map((file) => fold(file.relPath)));
  const root = path.resolve(workspaceRoot);
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s"'`(\[<{=,])((?:[A-Za-z]:)?[\w.@+\-/\\]*[\w@+\-]\.[A-Za-z]\w*)(?::(\d+)|\((\d+),\d+\)|", line (\d+))/gm;
  let examined = 0;
  for (const match of text.matchAll(re)) {
    if (++examined > MAX_CANDIDATES || found.length >= MAX_OTHERS) break;
    const named = match[1] as string;
    const line = match[2] ?? match[3] ?? match[4];
    const abs = path.resolve(root, named);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const relPath = rel.split(path.sep).join("/");
    if (/(^|\/)node_modules\//.test(relPath) || skip.has(fold(relPath))) continue;
    const key = `${fold(relPath)}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    found.push(`${relPath}:${line}`);
  }
  return found;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A path with either separator, single or doubled (JSON output), so Windows and POSIX output both match. */
function pathPattern(relPath: string): string {
  return relPath.split(/[\\/]+/).map(escapeRegex).join("[\\\\/]+");
}

export function pointsAt(output: string, files: BlameFile[], workspaceRoot: string): string {
  if (!output.trim() || files.length === 0) return "";
  const flags = process.platform === "win32" ? "gi" : "g";
  const text = relativeToRoot(output, workspaceRoot);
  // Before the path: the start of a line, a delimiter, or "./" (which is also how the workspace
  // root now reads), so a changed "a.js" is not confused with some other folder's "lib/a.js"
  // or with "../a.js".
  const before = `(?:^|[\\s"'\`(\\[<{=,]|(?<![\\w.\\-~])\\.[\\\\/]+)`;
  // After it: a line number in one of the usual spellings, or the end of the name.
  const after = `(?::(\\d+)(?::\\d+)?|\\((\\d+)[,:]\\d+\\)|", line (\\d+)|(?![\\w.\\-]))`;

  const mentions: string[] = [];
  const quoted: string[] = [];
  for (const file of files) {
    const re = new RegExp(`${before}${pathPattern(file.relPath)}${after}`, `${flags}m`);
    const lines: number[] = [];
    let named = false;
    for (const match of text.matchAll(re)) {
      named = true;
      const line = Number(match[1] ?? match[2] ?? match[3]);
      if (Number.isInteger(line) && line > 0 && !lines.includes(line)) lines.push(line);
      if (lines.length >= MAX_LINES_PER_FILE) break;
    }
    if (!named) continue;
    if (file.gone) {
      mentions.push(`${file.relPath} (${file.gone === "deleted" ? "deleted" : "moved away"} by this call)`);
      continue;
    }
    if (lines.length === 0 || file.ranges === null) {
      mentions.push(lines.length === 0 ? file.relPath : lines.map((line) => `${file.relPath}:${line}`).join(", "));
      continue;
    }
    const ranges = file.ranges;
    const shipped = file.text === undefined ? null : file.text.split(/\r?\n/);
    for (const line of lines) {
      mentions.push(
        `${file.relPath}:${line} (${rangesContain(ranges, line) ? "a line this call changed" : "not a line this call changed"})`,
      );
      const source = shipped?.[line - 1]?.trim();
      if (source && quoted.length < MAX_QUOTED) {
        quoted.push(
          `  ${file.relPath}:${line} | ${source.length > MAX_QUOTED_CHARS ? `${source.slice(0, MAX_QUOTED_CHARS)}…` : source}`,
        );
      }
    }
  }
  const others = otherFiles(text, files, workspaceRoot);
  const which = others.length > 1 ? "files this call did not change" : "a file this call did not change";
  if (mentions.length === 0) {
    return others.length === 0
      ? "The failing output does not mention any file this call changed."
      : `The failing output does not mention any file this call changed. It names ${others.join(", ")}, ${which}: often a caller or a test the change has not reached yet.`;
  }
  const shown = mentions.slice(0, MAX_MENTIONS);
  const more = mentions.length - shown.length;
  const also = others.length > 0 ? ` It also names ${others.join(", ")}, ${which}.` : "";
  const asSeen = quoted.length > 0 ? `\nAs the check saw ${quoted.length > 1 ? "those lines" : "that line"}, before the rollback:\n${quoted.join("\n")}` : "";
  return `The failing output mentions ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.${also}${asSeen}`;
}
