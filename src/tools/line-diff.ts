/**
 * Which lines of a file a change touched, counted in the file as it is after the change.
 *
 * ship reports these so the model knows where its edit landed without reading the file again,
 * and so a failing test that names a line can be matched to the edit that put it there.
 *
 * The diff anchors on lines that occur exactly once on both sides (as patience diff does),
 * trims what is the same at both ends of each stretch between anchors, and runs a small
 * longest-common-subsequence pass on what is left. A stretch too large for that pass is
 * reported whole, which is wider than the real change but never misses a changed line.
 */

export type LineRange = [number, number];

const MAX_LINES = 50000;
const MAX_TABLE_CELLS = 40000;

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return text === "" ? [] : lines;
}

/** Marks `changed[j]` for each line `j` (0-based) of `b` that is new, and the line after each removal. */
function walk(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
  changed: Uint8Array,
): void {
  // Stack instead of recursion: a long file with many anchors must not run out of stack.
  const stack: Array<[number, number, number, number]> = [[aStart, aEnd, bStart, bEnd]];
  while (stack.length > 0) {
    let [a0, a1, b0, b1] = stack.pop() as [number, number, number, number];
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      a0++;
      b0++;
    }
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
      a1--;
      b1--;
    }
    if (a0 === a1 && b0 === b1) continue;
    if (b0 === b1) {
      markRemoval(changed, b0);
      continue;
    }
    if (a0 === a1) {
      changed.fill(1, b0, b1);
      continue;
    }

    const anchors = uniqueAnchors(a, a0, a1, b, b0, b1);
    if (anchors.length > 0) {
      let pa = a0;
      let pb = b0;
      const pieces: Array<[number, number, number, number]> = [];
      for (const [ai, bj] of anchors) {
        pieces.push([pa, ai, pb, bj]);
        pa = ai + 1;
        pb = bj + 1;
      }
      pieces.push([pa, a1, pb, b1]);
      stack.push(...pieces);
      continue;
    }

    if ((a1 - a0) * (b1 - b0) <= MAX_TABLE_CELLS) {
      markByTable(a, a0, a1, b, b0, b1, changed);
    } else {
      changed.fill(1, b0, b1);
    }
  }
}

/** A removal has no line of its own in the new file: point at the line that now sits there. */
function markRemoval(changed: Uint8Array, position: number): void {
  const length = changed.length;
  if (length === 0) return;
  changed[Math.min(position, length - 1)] = 1;
}

/** Pairs (i in a, j in b) of lines unique on both sides, longest run that keeps their order. */
function uniqueAnchors(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
): Array<[number, number]> {
  const inA = new Map<string, number>();
  for (let i = a0; i < a1; i++) {
    const line = a[i] as string;
    inA.set(line, inA.has(line) ? -1 : i);
  }
  const inB = new Map<string, number>();
  for (let j = b0; j < b1; j++) {
    const line = b[j] as string;
    inB.set(line, inB.has(line) ? -1 : j);
  }
  const pairs: Array<[number, number]> = [];
  for (let j = b0; j < b1; j++) {
    const line = b[j] as string;
    const i = inA.get(line);
    if (i !== undefined && i >= 0 && inB.get(line) === j) pairs.push([i, j]);
  }
  if (pairs.length === 0) return [];

  // Longest increasing subsequence of the a-positions (pairs are already in b order).
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const value = (pairs[k] as [number, number])[0];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] as number] as [number, number])[0] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1] as number;
    tails[lo] = k;
  }
  const chain: Array<[number, number]> = [];
  for (let k = tails[tails.length - 1] as number; k !== -1; k = prev[k] as number) {
    chain.push(pairs[k] as [number, number]);
  }
  return chain.reverse();
}

function markByTable(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
  changed: Uint8Array,
): void {
  const n = a1 - a0;
  const m = b1 - b0;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[a0 + i] === b[b0 + j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      markRemoval(changed, b0 + j);
      i++;
    } else {
      changed[b0 + j] = 1;
      j++;
    }
  }
  if (i < n) markRemoval(changed, b0 + j);
  if (j < m) changed.fill(1, b0 + j, b1);
}

/**
 * 1-based, inclusive ranges of the lines in `after` that differ from `before`. Lines that were
 * only removed are marked by the line that follows them. Empty when nothing changed, or when
 * either side is too long to compare.
 */
export function changedLineRanges(before: string, after: string): LineRange[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return [];
  const changed = new Uint8Array(b.length);
  walk(a, 0, a.length, b, 0, b.length, changed);

  const ranges: LineRange[] = [];
  for (let j = 0; j < changed.length; j++) {
    if (!changed[j]) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === j) last[1] = j + 1;
    else ranges.push([j + 1, j + 1]);
  }
  return ranges;
}

/** Number of lines, counted as an editor shows them. */
export function lineCount(text: string): number {
  return splitLines(text).length;
}

/** "line 4", "lines 4-9, 30" or "lines 4-9, 30, 41, 52-60 and 3 more places". */
export function formatRanges(ranges: LineRange[], limit = 4): string {
  if (ranges.length === 0) return "";
  const shown = ranges.slice(0, limit).map(([from, to]) => (from === to ? String(from) : `${from}-${to}`));
  const single = ranges.length === 1 && ranges[0]?.[0] === ranges[0]?.[1];
  const rest = ranges.length - shown.length;
  return `${single ? "line" : "lines"} ${shown.join(", ")}${rest > 0 ? ` and ${rest} more place${rest > 1 ? "s" : ""}` : ""}`;
}

export function rangesContain(ranges: LineRange[], line: number): boolean {
  return ranges.some(([from, to]) => line >= from && line <= to);
}
