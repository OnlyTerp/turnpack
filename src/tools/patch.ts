import { endOfLine, findAnchorLine, HOW_LABEL, replaceLineBlock } from "./edit-match.js";

/**
 * Patches for `ship`.
 *
 * Some models are trained to write changes as a patch rather than as search/replace pairs:
 * OpenAI's models use the `apply_patch` format, and every model can write a unified diff. Their
 * apps apply such a patch without running anything afterwards. Accepting the same text here
 * means those models keep the format they are best at and gain what `ship` adds: the check runs
 * in the same call, and a failure puts every file back.
 *
 * Two formats are read:
 *
 *   *** Begin Patch                        --- a/src/tax.js
 *   *** Update File: src/tax.js            +++ b/src/tax.js
 *   @@ export function tax(n) {            @@ -3,3 +3,3 @@
 *   -  return n * RATE;                     export function tax(n) {
 *   +  return round(n * RATE);             -  return n * RATE;
 *   *** Add File: src/round.js             +  return round(n * RATE);
 *   +export const round = Math.round;       }
 *   *** Delete File: src/old.js
 *   *** End Patch
 *
 * Line numbers in a unified diff are ignored. A model's line numbers are a guess; the context
 * lines are what it actually saw, so each hunk is placed by its context, in order.
 */

export interface PatchHunk {
  /** Text of `@@ …` lines: lines the hunk comes after, outermost first. */
  anchors: string[];
  /** Context and removed lines, as they should be in the file now. */
  before: string[];
  /** Context and added lines, as they should be afterwards. */
  after: string[];
  /** The hunk was marked as sitting at the end of the file. */
  atEnd: boolean;
}

export interface PatchFile {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo?: string;
  /** For "add": the new file's text. */
  content?: string;
  hunks: PatchHunk[];
}

function newHunk(anchor = ""): PatchHunk {
  return { anchors: anchor ? [anchor] : [], before: [], after: [], atEnd: false };
}

/** Sorts one line of a hunk body into what is there now and what should be there. */
function addBodyLine(hunk: PatchHunk, line: string): void {
  if (line.startsWith("+")) hunk.after.push(line.slice(1));
  else if (line.startsWith("-")) hunk.before.push(line.slice(1));
  else {
    // A context line. Its leading space is often dropped on blank lines, and sometimes on all.
    const body = line.startsWith(" ") ? line.slice(1) : line;
    hunk.before.push(body);
    hunk.after.push(body);
  }
}

function finishFile(file: PatchFile | null, addLines: string[], files: PatchFile[]): void {
  if (!file) return;
  if (file.kind === "add") file.content = addLines.length > 0 ? `${addLines.join("\n")}\n` : "";
  file.hunks = file.hunks.filter((hunk) => hunk.before.length > 0 || hunk.after.length > 0);
  files.push(file);
}

function parseApplyPatch(lines: string[]): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let addLines: string[] = [];

  for (const line of lines) {
    if (/^\*\*\* (Begin|End) Patch\s*$/.test(line)) continue;
    const header = /^\*\*\* (Add|Delete|Update) File: (.+?)\s*$/.exec(line);
    if (header) {
      finishFile(file, addLines, files);
      file = { kind: header[1]?.toLowerCase() as PatchFile["kind"], path: header[2] ?? "", hunks: [] };
      hunk = null;
      addLines = [];
      continue;
    }
    if (!file) {
      if (line.trim() === "") continue;
      throw new Error(`patch: expected "*** Update File: <path>", "*** Add File: <path>" or "*** Delete File: <path>", got ${JSON.stringify(line.slice(0, 80))}`);
    }
    const move = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (move) {
      file.moveTo = move[1];
      continue;
    }
    if (/^\*\*\* End of File\s*$/.test(line)) {
      if (hunk) hunk.atEnd = true;
      continue;
    }
    if (file.kind === "delete") continue;
    if (file.kind === "add") {
      addLines.push(line.startsWith("+") ? line.slice(1) : line);
      continue;
    }
    if (line.startsWith("@@")) {
      const anchor = line.replace(/^@@+/, "").replace(/@@+\s*$/, "").trim();
      // Several "@@" lines in a row narrow one place down: class, then method.
      if (hunk && hunk.before.length === 0 && hunk.after.length === 0) {
        if (anchor) hunk.anchors.push(anchor);
      } else {
        hunk = newHunk(anchor);
        file.hunks.push(hunk);
      }
      continue;
    }
    if (!hunk) {
      hunk = newHunk();
      file.hunks.push(hunk);
    }
    addBodyLine(hunk, line);
  }
  finishFile(file, addLines, files);
  return files;
}

function diffPath(raw: string): string | null {
  const name = raw.split("\t")[0]?.trim() ?? "";
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(lines: string[]): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let addLines: string[] = [];
  let oldPath: string | null = null;
  let renameFrom: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      finishFile(file, addLines, files);
      file = null;
      hunk = null;
      renameFrom = null;
      continue;
    }
    if (!hunk || line.startsWith("--- ")) {
      const rename = /^rename (from|to) (.+)$/.exec(line);
      if (rename) {
        if (rename[1] === "from") renameFrom = rename[2] ?? null;
        else if (renameFrom && !file) {
          // A pure rename has no "---"/"+++" lines at all.
          file = { kind: "update", path: renameFrom, moveTo: rename[2], hunks: [] };
        }
        continue;
      }
      if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
        if (file && !(file.moveTo && file.hunks.length === 0)) finishFile(file, addLines, files);
        oldPath = diffPath(line.slice(4));
        const newPath = diffPath((lines[i + 1] ?? "").slice(4));
        i += 1;
        addLines = [];
        hunk = null;
        if (oldPath === null && newPath === null) throw new Error("patch: a diff names /dev/null on both sides");
        file =
          oldPath === null
            ? { kind: "add", path: newPath ?? "", hunks: [] }
            : newPath === null
              ? { kind: "delete", path: oldPath, hunks: [] }
              : { kind: "update", path: oldPath, ...(newPath !== oldPath ? { moveTo: newPath } : {}), hunks: [] };
        continue;
      }
    }
    if (!file) continue; // "index 123..456", "new file mode", free text before the first file
    if (line.startsWith("@@")) {
      hunk = newHunk();
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (!hunk || file.kind === "delete") continue;
    if (file.kind === "add") {
      if (line.startsWith("+")) addLines.push(line.slice(1));
      continue;
    }
    addBodyLine(hunk, line);
  }
  finishFile(file, addLines, files);
  return files;
}

/** Reads a patch in either format. Throws with a message a model can act on. */
export function parsePatch(text: string): PatchFile[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline is not an extra blank context line.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const isApplyPatch = lines.some((line) => /^\*\*\* (Add|Delete|Update) File: /.test(line));
  const isUnified = lines.some((line, i) => line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ "));
  const files = isApplyPatch ? parseApplyPatch(lines) : isUnified ? parseUnifiedDiff(lines) : [];
  if (files.length === 0) {
    throw new Error(
      'patch: no files found. Use the apply_patch format ("*** Begin Patch", "*** Update File: path", "@@", lines starting with space, - or +, "*** End Patch") or a unified diff ("--- a/path", "+++ b/path", "@@").',
    );
  }
  for (const file of files) {
    if (!file.path.trim()) throw new Error("patch: a file header has no path");
    if (file.kind === "update" && file.hunks.length === 0 && !file.moveTo) {
      throw new Error(`patch: "${file.path}" is marked for update but has no changes`);
    }
  }
  return files;
}

export type HunksApplied = { ok: true; text: string; notes: string[] } | { ok: false; message: string };

/** Applies one file's hunks in order. Nothing is written; the new text is returned. */
export function applyHunks(original: string, hunks: PatchHunk[]): HunksApplied {
  let text = original;
  let cursor = 0;
  const notes: string[] = [];
  const eol = original.includes("\r\n") ? "\r\n" : "\n";

  for (let n = 0; n < hunks.length; n++) {
    const hunk = hunks[n];
    if (!hunk) continue;
    const label = hunks.length > 1 ? `hunk ${n + 1} of ${hunks.length}` : "the hunk";

    let anchorStart: number | null = null;
    for (const anchor of hunk.anchors) {
      const found = findAnchorLine(text, anchor, anchorStart ?? cursor);
      if (found !== null) anchorStart = found;
    }
    if (anchorStart !== null) cursor = anchorStart;

    if (hunk.before.length === 0) {
      // Nothing to find: the lines are new. They go after the anchor, or at the end of the file.
      const block = hunk.after.join(eol) + eol;
      if (anchorStart !== null && !hunk.atEnd) {
        const at = endOfLine(text, anchorStart);
        const head = at === text.length && !text.endsWith("\n") ? `${text}${eol}` : text.slice(0, at);
        text = head + block + text.slice(at);
        cursor = head.length + block.length;
      } else {
        const head = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
        text = head + block;
        cursor = text.length;
      }
      continue;
    }

    const outcome = replaceLineBlock(text, hunk.before, hunk.after, cursor);
    if (!outcome.ok) {
      return { ok: false, message: `${label}: ${outcome.message.replace(/^search text/, "its context and removed lines were")}` };
    }
    if (outcome.how !== "exact") notes.push(`${label} matched by ignoring ${HOW_LABEL[outcome.how]}`);
    text = outcome.text;
    cursor = outcome.end;
  }
  return { ok: true, text, notes };
}
