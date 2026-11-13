/**
 * Search/replace matching for `ship`.
 *
 * A model writes an edit from its memory of a file, and that memory is often right about the
 * code and wrong about the bytes: an indent one level off, tabs remembered as spaces, a
 * trailing space dropped, the line numbers `pack` printed copied along with the code, a curly
 * quote typed straight. Refusing each of those costs a full extra turn (re-read, re-send) for a
 * difference nobody meant.
 *
 * So matching is a ladder. The exact text is tried first and wins whenever it is there. Only if
 * it is absent are looser comparisons tried, one at a time, each comparing whole lines:
 *
 *   exact  →  line endings  →  copied line numbers  →  trailing whitespace  →  indentation  →  punctuation
 *
 * A looser rung is used only when it identifies the place unambiguously (or `replace_all` is
 * set), and the caller is told which rung matched so the reply can say so. Nothing here guesses
 * between two candidate places.
 *
 * When no rung matches, `describeNearest` finds the most similar region and shows it with line
 * numbers and the first differing line, so the next attempt can be written without re-reading.
 */

export type MatchHow =
  | "exact"
  | "line-endings"
  | "line-numbers"
  | "trailing-whitespace"
  | "indentation"
  | "punctuation";

export interface EditApplied {
  ok: true;
  text: string;
  how: MatchHow;
  count: number;
}

export interface EditMiss {
  ok: false;
  kind: "empty" | "not-found" | "ambiguous";
  /** Complete, model-readable explanation, without the file name. */
  message: string;
}

export type EditOutcome = EditApplied | EditMiss;

/** What a looser match ignored, in the words used in replies. */
export const HOW_LABEL: Record<MatchHow, string> = {
  exact: "exact",
  "line-endings": "line endings",
  "line-numbers": "line numbers copied from a listing",
  "trailing-whitespace": "trailing whitespace",
  indentation: "indentation",
  punctuation: "indentation and typographic quotes or dashes",
};

interface FileLine {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the last character before the line ending. */
  bodyEnd: number;
  /** Offset just past the line ending (equal to bodyEnd on a last line with none). */
  end: number;
  body: string;
}

function splitLines(text: string): FileLine[] {
  const lines: FileLine[] = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) {
      lines.push({ start: pos, bodyEnd: text.length, end: text.length, body: text.slice(pos) });
      return lines;
    }
    const bodyEnd = nl > pos && text[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ start: pos, bodyEnd, end: nl + 1, body: text.slice(pos, bodyEnd) });
    pos = nl + 1;
  }
}

function lineNumberAt(lines: FileLine[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lines[mid]?.start ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

function listLines(numbers: number[]): string {
  const shown = numbers.slice(0, 8).join(", ");
  return numbers.length > 8 ? `${shown}, and ${numbers.length - 8} more` : shown;
}

function ambiguous(lineNumbers: number[], ignoring?: string): EditMiss {
  return {
    ok: false,
    kind: "ambiguous",
    message:
      `search text matches ${lineNumbers.length} places (lines ${listLines(lineNumbers)})` +
      `${ignoring ? ` when ${ignoring} is ignored` : ""}. ` +
      "Add a neighbouring line to the search so it names one place, or pass replace_all: true.",
  };
}

// "  12 | code" is how pack prints a line; "    12\tcode" is `cat -n`; "12→code" is another
// common listing style. A search made only of such lines was copied from a listing.
const GUTTER = /^[>\s]*\d+(?: \|(?: |$)|\t|→)/;

function stripGutter(lines: string[]): string[] | null {
  const meaningful = lines.filter((line) => line.trim() !== "");
  if (meaningful.length === 0 || !meaningful.every((line) => GUTTER.test(line))) return null;
  return lines.map((line) => line.replace(GUTTER, ""));
}

const PUNCTUATION: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/[            　]/g, " "],
  [/…/g, "..."],
];

function foldPunctuation(value: string): string {
  let out = value;
  for (const [pattern, plain] of PUNCTUATION) out = out.replace(pattern, plain);
  return out;
}

function leadingWhitespace(value: string): string {
  return /^[ \t]*/.exec(value)?.[0] ?? "";
}

/**
 * Rewrites the indentation of replacement lines from the way the model wrote the block to the
 * way the file has it.
 *
 * The matched lines are the evidence: line k of the search was written with one indent and the
 * file has another, which gives a small dictionary from "the model's indent" to "the file's
 * indent" (no indent → one tab, four spaces → two tabs). A replacement line whose indent is in
 * the dictionary is translated outright. One that is deeper than anything matched is
 * extrapolated from the step between two matched depths, and failing that keeps its extra
 * indentation on top of the nearest known depth.
 */
function reindentLike(replaceLines: string[], searchLines: string[], fileLines: string[]): string[] {
  const known = new Map<string, string>();
  for (let k = 0; k < searchLines.length; k++) {
    const searchLine = searchLines[k] ?? "";
    const fileLine = fileLines[k] ?? "";
    if (searchLine.trim() === "" || fileLine.trim() === "") continue;
    const indent = leadingWhitespace(searchLine);
    if (!known.has(indent)) known.set(indent, leadingWhitespace(fileLine));
  }
  if (known.size === 0 || [...known].every(([from, to]) => from === to)) return replaceLines;

  // One level of nesting, as the model writes it and as the file writes it.
  const depths = [...known.keys()].sort((a, b) => a.length - b.length);
  let step: { from: number; to: string } | null = null;
  for (let i = 1; i < depths.length && !step; i++) {
    const shallow = depths[i - 1] ?? "";
    const deep = depths[i] ?? "";
    const fileShallow = known.get(shallow) ?? "";
    const fileDeep = known.get(deep) ?? "";
    if (deep.startsWith(shallow) && fileDeep.startsWith(fileShallow) && fileDeep.length > fileShallow.length) {
      step = { from: deep.length - shallow.length, to: fileDeep.slice(fileShallow.length) };
    }
  }
  // With one matched depth and a file that indents with tabs, a level is taken to be the
  // smallest extra indent the replacement itself uses.
  const extras = replaceLines
    .filter((line) => line.trim() !== "")
    .map((line) => leadingWhitespace(line))
    .map((indent) => {
      const base = depths.filter((depth) => indent.startsWith(depth)).pop();
      return base === undefined ? 0 : indent.length - base.length;
    })
    .filter((extra) => extra > 0);
  const smallestExtra = extras.length > 0 ? Math.min(...extras) : 0;

  return replaceLines.map((line) => {
    if (line.trim() === "") return line;
    const indent = leadingWhitespace(line);
    const rest = line.slice(indent.length);
    const direct = known.get(indent);
    if (direct !== undefined) return direct + rest;

    const base = depths.filter((depth) => indent.startsWith(depth)).pop();
    if (base === undefined) return line; // shallower than anything matched: leave it as written
    const fileBase = known.get(base) ?? "";
    const extra = indent.slice(base.length);
    if (step && extra.length % step.from === 0) {
      return fileBase + step.to.repeat(extra.length / step.from) + rest;
    }
    if (/^\t+$/.test(fileBase) && /^ +$/.test(extra) && smallestExtra > 0 && extra.length % smallestExtra === 0) {
      return fileBase + "\t".repeat(extra.length / smallestExtra) + rest;
    }
    return fileBase + extra + rest;
  });
}

interface Rung {
  how: MatchHow;
  normalize: (line: string) => string;
  /** Whether the replacement needs its indentation moved to where the file has it. */
  reindent: boolean;
}

const RUNGS: Rung[] = [
  { how: "trailing-whitespace", normalize: (line) => line.replace(/[ \t]+$/, ""), reindent: false },
  { how: "indentation", normalize: (line) => line.trim(), reindent: true },
  { how: "punctuation", normalize: (line) => foldPunctuation(line).trim(), reindent: true },
];

function findLineMatches(fileNorm: string[], wanted: string[]): number[] {
  const hits: number[] = [];
  const n = wanted.length;
  const first = wanted[0];
  for (let i = 0; i + n <= fileNorm.length; i++) {
    if (fileNorm[i] !== first) continue;
    let same = true;
    for (let k = 1; k < n; k++) {
      if (fileNorm[i + k] !== wanted[k]) {
        same = false;
        break;
      }
    }
    if (same) {
      hits.push(i);
      i += n - 1; // matches may not overlap
    }
  }
  return hits;
}

/**
 * Applies one search/replace to `text`. See the file comment for the order of attempts.
 */
export function applySearchReplace(
  text: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): EditOutcome {
  if (!search) {
    return { ok: false, kind: "empty", message: "the search text is empty" };
  }

  // Rung 1: the text exactly as written.
  let exact = occurrences(text, search);
  let how: MatchHow = "exact";
  let exactSearch = search;
  let exactReplace = replace;

  // Rung 2: the same text with the file's line endings.
  const fileUsesCrlf = text.includes("\r\n");
  const eol = fileUsesCrlf ? "\r\n" : "\n";
  const toFileEol = (value: string): string => {
    const lf = value.replace(/\r\n/g, "\n");
    return fileUsesCrlf ? lf.replace(/\n/g, "\r\n") : lf;
  };
  if (exact.length === 0 && /\n/.test(search)) {
    const alt = toFileEol(search);
    if (alt !== search) {
      const altHits = occurrences(text, alt);
      if (altHits.length > 0) {
        exact = altHits;
        exactSearch = alt;
        exactReplace = toFileEol(replace);
        how = "line-endings";
      }
    }
  }

  let fileLines: FileLine[] | undefined;
  const linesOfFile = (): FileLine[] => (fileLines ??= splitLines(text));

  if (exact.length > 1 && !replaceAll) {
    return ambiguous(exact.map((offset) => lineNumberAt(linesOfFile(), offset)));
  }
  if (exact.length > 0) {
    return { ok: true, text: text.split(exactSearch).join(exactReplace), how, count: exact.length };
  }

  // From here on the comparison is line by line.
  let searchLines = search.replace(/\r\n/g, "\n").split("\n");
  let replaceLines = replace.replace(/\r\n/g, "\n").split("\n");

  // A search that ends in a newline covers its last line's ending too.
  const coversLastEnding = searchLines.length > 1 && searchLines[searchLines.length - 1] === "";
  if (coversLastEnding) searchLines = searchLines.slice(0, -1);

  let gutterStripped = false;
  const withoutGutter = stripGutter(searchLines);
  if (withoutGutter) {
    searchLines = withoutGutter;
    replaceLines = replaceLines.map((line) => line.replace(GUTTER, ""));
    gutterStripped = true;
  }

  const file = linesOfFile();
  const bodies = file.map((line) => line.body);

  const rungs: Rung[] = gutterStripped
    ? [{ how: "line-numbers", normalize: (line) => line, reindent: false }, ...RUNGS]
    : RUNGS;

  for (const rung of rungs) {
    const wanted = searchLines.map(rung.normalize);
    // A search that normalises to nothing would match every blank line.
    if (wanted.every((line) => line === "")) continue;
    const hits = findLineMatches(bodies.map(rung.normalize), wanted);
    if (hits.length === 0) continue;
    const label = rung.how;
    if (hits.length > 1 && !replaceAll) {
      return ambiguous(
        hits.map((index) => index + 1),
        HOW_LABEL[label],
      );
    }

    const pieces: string[] = [];
    let cursor = 0;
    for (const index of hits) {
      const firstLine = file[index];
      const lastLine = file[index + searchLines.length - 1];
      if (!firstLine || !lastLine) continue;
      const lines = rung.reindent
        ? reindentLike(replaceLines, searchLines, bodies.slice(index, index + searchLines.length))
        : replaceLines;
      pieces.push(text.slice(cursor, firstLine.start), lines.join(eol));
      cursor = coversLastEnding ? lastLine.end : lastLine.bodyEnd;
    }
    pieces.push(text.slice(cursor));
    return { ok: true, text: pieces.join(""), how: label, count: hits.length };
  }

  return { ok: false, kind: "not-found", message: describeNearest(text, searchLines) };
}

export interface BlockReplaced {
  ok: true;
  text: string;
  how: MatchHow;
  /** Offset in the new text just past what was put in. */
  end: number;
}

/**
 * Replaces one block of whole lines. This is what a patch hunk needs: the hunk's context and
 * removed lines are `searchLines`, its context and added lines are `replaceLines`.
 *
 * The same ladder of comparisons is used as for a search/replace edit. A patch is applied top to
 * bottom, so when a block occurs more than once the first occurrence at or after `after` is the
 * one meant; without `after`, more than one occurrence is an error.
 */
export function replaceLineBlock(
  text: string,
  searchLines: string[],
  replaceLines: string[],
  after?: number,
): BlockReplaced | EditMiss {
  const file = splitLines(text);
  const bodies = file.map((line) => line.body);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rungs: Rung[] = [{ how: "exact", normalize: (line) => line, reindent: false }, ...RUNGS];

  for (const rung of rungs) {
    const wanted = searchLines.map(rung.normalize);
    if (wanted.every((line) => line === "")) continue;
    const hits = findLineMatches(bodies.map(rung.normalize), wanted);
    if (hits.length === 0) continue;
    let index = hits[0] ?? 0;
    if (hits.length > 1) {
      if (after === undefined) {
        return ambiguous(
          hits.map((hit) => hit + 1),
          rung.how === "exact" ? undefined : HOW_LABEL[rung.how],
        );
      }
      index = hits.find((hit) => (file[hit]?.start ?? 0) >= after) ?? index;
    }
    const firstLine = file[index];
    const lastLine = file[index + searchLines.length - 1];
    if (!firstLine || !lastLine) continue;

    const lines = rung.reindent
      ? reindentLike(replaceLines, searchLines, bodies.slice(index, index + searchLines.length))
      : replaceLines;
    // Lines replaced by nothing take their line ending with them, so no blank line is left.
    const head = text.slice(0, firstLine.start);
    const inserted = lines.join(eol);
    const tail = lines.length === 0 ? text.slice(lastLine.end) : text.slice(lastLine.bodyEnd);
    return { ok: true, text: head + inserted + tail, how: rung.how, end: head.length + inserted.length };
  }
  return { ok: false, kind: "not-found", message: describeNearest(text, searchLines) };
}

/** Offset of the start of the first line at or after `from` whose text is (or contains) `anchor`. */
export function findAnchorLine(text: string, anchor: string, from: number): number | null {
  const wanted = anchor.trim();
  if (!wanted) return null;
  const file = splitLines(text);
  const candidates = file.filter((line) => line.start >= from);
  const exact = candidates.find((line) => line.body.trim() === wanted);
  const loose = exact ?? candidates.find((line) => line.body.includes(wanted));
  return loose ? loose.start : null;
}

/** Offset just past the line that starts at `lineStart`, including its line ending. */
export function endOfLine(text: string, lineStart: number): number {
  const nl = text.indexOf("\n", lineStart);
  return nl === -1 ? text.length : nl + 1;
}

function tokensOf(line: string): string[] {
  return line.match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g) ?? [];
}

/** Token overlap between two lines, 0 to 1. Order-blind, which is fine for "is this the place". */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of ta) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of tb) {
    const left = counts.get(token);
    if (left) {
      common += 1;
      counts.set(token, left - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}

const MAX_SCAN_LINES = 60000;
const MAX_SNIPPET_LINES = 12;

function quoteLine(line: string): string {
  const shown = line.length > 160 ? `${line.slice(0, 160)}…` : line;
  return JSON.stringify(shown);
}

/**
 * Explains a search that matched nowhere: the most similar region of the file with line
 * numbers, how much of it agrees, and the first line that does not.
 */
export function describeNearest(text: string, searchLinesRaw: string[]): string {
  const file = splitLines(text);
  const total = file.length;
  const wanted = searchLinesRaw.map((line) => line.trim());
  const fileTrim = file.slice(0, MAX_SCAN_LINES).map((line) => line.body.trim());
  const nothing = `search text not found, and nothing close to it is in the file (${total} lines). Read the file with pack and write the search from what is there.`;

  // Find candidate positions through the search's most distinctive line: its longest.
  let probe = 0;
  for (let k = 1; k < wanted.length; k++) {
    if ((wanted[k]?.length ?? 0) > (wanted[probe]?.length ?? 0)) probe = k;
  }
  const probeLine = wanted[probe] ?? "";
  if (!probeLine) return nothing;

  const candidates: Array<{ start: number; score: number }> = [];
  for (let j = 0; j < fileTrim.length; j++) {
    const score = similarity(fileTrim[j] ?? "", probeLine);
    if (score >= 0.5) candidates.push({ start: j - probe, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  let best: { start: number; score: number; identical: number } | null = null;
  for (const candidate of candidates.slice(0, 12)) {
    let sum = 0;
    let identical = 0;
    for (let k = 0; k < wanted.length; k++) {
      const fileLine = fileTrim[candidate.start + k];
      if (fileLine === undefined) continue;
      const score = similarity(fileLine, wanted[k] ?? "");
      sum += score;
      if (fileLine === wanted[k]) identical += 1;
    }
    const mean = sum / wanted.length;
    if (!best || mean > best.score) best = { start: candidate.start, score: mean, identical };
  }
  if (!best || best.score < 0.35) return nothing;

  const from = Math.max(0, best.start);
  const to = Math.min(total, best.start + wanted.length); // exclusive
  let firstDiff = -1;
  for (let k = 0; k < wanted.length; k++) {
    if (fileTrim[best.start + k] !== wanted[k]) {
      firstDiff = k;
      break;
    }
  }

  // Show the whole region when it is short, otherwise the part around the first difference.
  let showFrom = from;
  let showTo = to;
  if (to - from > MAX_SNIPPET_LINES) {
    const centre = best.start + Math.max(0, firstDiff);
    showFrom = Math.max(from, centre - 3);
    showTo = Math.min(to, showFrom + MAX_SNIPPET_LINES);
  }
  const width = String(showTo).length;
  const snippet: string[] = [];
  for (let i = showFrom; i < showTo; i++) {
    const body = file[i]?.body ?? "";
    snippet.push(`  ${String(i + 1).padStart(width, " ")} | ${body.length > 200 ? `${body.slice(0, 200)}…` : body}`);
  }

  const out = [
    `search text not found. The closest text is lines ${from + 1}-${to} (${best.identical} of ${wanted.length} line(s) identical apart from indentation):`,
    ...snippet,
  ];
  if (showTo < to || showFrom > from) out.push(`  (showing lines ${showFrom + 1}-${showTo})`);
  if (firstDiff !== -1) {
    const fileLine = file[best.start + firstDiff];
    out.push(
      fileLine
        ? `First difference, at line ${best.start + firstDiff + 1}:`
        : "First difference: the search runs past the end of the file:",
      `  search has: ${quoteLine(searchLinesRaw[firstDiff] ?? "")}`,
      `  file has:   ${fileLine ? quoteLine(fileLine.body) : "(no such line)"}`,
    );
  }
  return out.join("\n");
}
