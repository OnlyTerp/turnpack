import fs from "node:fs";
import { describeChecks, detectChecks } from "../checks.js";
import { isSecretPath, resolveSafePath, resolveWorkspaceRoot, writePrivateShard } from "../security.js";
import {
  isRecord,
  optionalBoolean,
  optionalList,
  optionalNumber,
  optionalString,
  optionalStringList,
  pick,
  ROOT_KEYS,
  unknownWorkKeys,
  unwrapJson,
} from "../validate.js";
import {
  extractSymbols,
  isBinaryBuffer,
  runGitStatus,
  runGlobList,
  runSearch,
  sliceLines,
  suggestPaths,
  walkWorkspaceFiles,
  type SearchHit,
} from "../workspace.js";

export interface PackFileSpec {
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
  /** List the file's functions and classes instead of its text. */
  outline?: boolean;
}

export interface PackArgs {
  root?: string;
  query?: string;
  literal?: boolean;
  context?: number;
  files?: Array<string | PackFileSpec>;
  globs?: string[];
  git_status?: boolean;
  inline_only?: boolean;
  max_bytes?: number;
  max_matches?: number;
  allow_secrets?: boolean;
}

export interface ClientContext {
  clientName: string;
  maxInlineBytes: number;
  readToolHint: string;
}

interface Section {
  heading: string;
  body: string;
}

const MIN_INLINE_BYTES = 4000;
const MAX_INLINE_BYTES = 44000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GLOB_LINES = 200;
const MAX_CONTEXT_LINES = 30;

const QUERY_KEYS = ["query", "pattern", "search", "regex"] as const;
const FILES_KEYS = ["files", "file", "paths", "path"] as const;
const GLOBS_KEYS = ["globs", "glob"] as const;
const FILE_PATH_KEYS = ["path", "file_path", "file", "filename"] as const;
const KNOWN_PACK_KEYS: readonly string[] = [
  ...ROOT_KEYS,
  ...QUERY_KEYS,
  ...FILES_KEYS,
  ...GLOBS_KEYS,
  "literal",
  "context",
  "git_status",
  "inline_only",
  "max_bytes",
  "max_matches",
  "allow_secrets",
];

/**
 * Reads one entry of `files`. The string forms are:
 *
 *   "src/app.ts"            the whole file
 *   "src/app.ts:10-80"      a line range ("src/app.ts:42" is the region around a line)
 *   "src/app.ts#L10-L80"    the same, as GitHub writes it
 *   "src/app.ts#login"      one function or class
 *   "src/app.ts#"           the file's outline
 *
 * A name that is a real file is always read as that file, whatever it ends in, so a file
 * called `notes#1` or a directory called `C#` is never mistaken for one of the forms above.
 */
function parseFileSpec(item: unknown, idx: number, isFile: (candidate: string) => boolean): PackFileSpec {
  if (isRecord(item)) {
    const filePath = pick(item, FILE_PATH_KEYS);
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error(`pack.files[${idx}].path must be a non-empty string`);
    }
    return {
      path: filePath,
      start_line: optionalNumber(pick(item, ["start_line", "start", "from"]), `pack.files[${idx}].start_line`),
      end_line: optionalNumber(pick(item, ["end_line", "end", "to"]), `pack.files[${idx}].end_line`),
      symbol: optionalString(pick(item, ["symbol", "name"]), `pack.files[${idx}].symbol`),
    };
  }
  if (typeof item !== "string" || !item.trim()) {
    throw new Error(`pack.files[${idx}] must be a file path such as "src/app.ts", "src/app.ts:10-80" or "src/app.ts#symbol"`);
  }
  const text = item.trim();
  if (isFile(text)) return { path: text };

  const hashLines = /^(.+)#L(\d+)(?:-L?(\d+))?$/.exec(text);
  if (hashLines?.[1]) {
    const start = Number(hashLines[2]);
    return { path: hashLines[1], start_line: start, end_line: hashLines[3] ? Number(hashLines[3]) : start };
  }
  const hash = /^(.+)#([^#/\\\s]*)$/.exec(text);
  if (hash?.[1]) {
    return hash[2] ? { path: hash[1], symbol: hash[2] } : { path: hash[1], outline: true };
  }
  const rangeMatch = /^(.+):(\d+)-(\d+)$/.exec(text);
  if (rangeMatch?.[1]) {
    return { path: rangeMatch[1], start_line: Number(rangeMatch[2]), end_line: Number(rangeMatch[3]) };
  }
  const singleMatch = /^(.+):(\d+)$/.exec(text);
  if (singleMatch?.[1]) {
    const line = Number(singleMatch[2]);
    return { path: singleMatch[1], start_line: Math.max(1, line - 20), end_line: line + 60 };
  }
  return { path: text };
}

function readSingleFileSection(
  workspaceRoot: string,
  spec: PackFileSpec,
  allowSecrets: boolean,
): string {
  let safe: { absPath: string; relPath: string };
  try {
    safe = resolveSafePath(workspaceRoot, spec.path);
  } catch (err) {
    // One bad path must not cost the caller every other file in the same pack.
    return `### FILE: ${spec.path}\n[BLOCKED: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (!allowSecrets && isSecretPath(safe.relPath, workspaceRoot)) {
    return `### FILE: ${safe.relPath}\n[REDACTED SECRET FILE: ${safe.relPath} — pass allow_secrets: true if intentional]`;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(safe.absPath);
  } catch {
    return `### FILE: ${safe.relPath}\n[NOT FOUND: ${safe.relPath}.${suggestPaths(workspaceRoot, safe.relPath)}]`;
  }
  if (stat.isDirectory()) {
    // A directory where a file was expected usually means "what is in here?". Answer that.
    try {
      const entries = fs
        .readdirSync(safe.absPath, { withFileTypes: true })
        .filter((entry) => allowSecrets || !isSecretPath(`${safe.relPath}/${entry.name}`, workspaceRoot))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => a.localeCompare(b));
      const shown = entries.slice(0, 100);
      return `### DIRECTORY: ${safe.relPath} (${entries.length} entries)\n${shown.join("\n") || "(empty)"}${
        entries.length > shown.length ? `\n... (+${entries.length - shown.length} more; use globs for the rest)` : ""
      }`;
    } catch (err) {
      return `### FILE: ${safe.relPath}\n[UNREADABLE: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  if (!stat.isFile()) {
    return `### FILE: ${safe.relPath}\n[SKIPPED: ${safe.relPath} is not a regular file]`;
  }
  if (stat.size > MAX_FILE_BYTES) {
    return `### FILE: ${safe.relPath}\n[SKIPPED: ${safe.relPath} exceeds 2 MB (${stat.size} bytes)]`;
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(safe.absPath);
  } catch (err) {
    return `### FILE: ${safe.relPath}\n[UNREADABLE: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (isBinaryBuffer(buf)) {
    return `### FILE: ${safe.relPath}\n[BINARY FILE: ${safe.relPath} (${buf.length} bytes)]`;
  }

  const content = buf.toString("utf8");
  if (spec.outline) {
    const symbols = extractSymbols(content);
    const lines = symbols.slice(0, 200).map((s) => `${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
    const total = content.split(/\r?\n/).length;
    return `### OUTLINE: ${safe.relPath} (${total} lines, ${symbols.length} symbols)\n${
      lines.join("\n") || "(no functions or classes recognised; read the file by line range)"
    }`;
  }
  if (spec.symbol) {
    const wanted = spec.symbol;
    const symbols = extractSymbols(content);
    const found =
      symbols.find((s) => s.name === wanted) ??
      symbols.find((s) => s.name.toLowerCase().includes(wanted.toLowerCase()));
    if (!found) {
      const available = symbols.slice(0, 12).map((s) => `${s.name}:${s.startLine}`).join(", ");
      return `### SYMBOL: ${safe.relPath} :: ${wanted}\n[SYMBOL NOT FOUND: available: ${available || "(none)"}]`;
    }
    const sliced = sliceLines(content, found.startLine, found.endLine);
    return `### SYMBOL: ${safe.relPath} :: ${found.kind} ${found.name} (L${sliced.start}-${sliced.end}/${sliced.totalLines})\n${sliced.formatted}`;
  }

  const sliced = sliceLines(content, spec.start_line ?? 1, spec.end_line);
  let more = "";
  if (spec.end_line === undefined && sliced.end < sliced.totalLines) {
    // Say what is in the part that was not shown, so the next request can go straight to it.
    const below = extractSymbols(content)
      .filter((s) => s.startLine > sliced.end)
      .slice(0, 12)
      .map((s) => `${s.name} L${s.startLine}-${s.endLine}`)
      .join(", ");
    more = `\n[... ${sliced.totalLines - sliced.end} more lines; request "${safe.relPath}:${sliced.end + 1}-${sliced.totalLines}" for the rest${below ? `. Further down: ${below}` : ""}]`;
  }
  return `### FILE: ${safe.relPath} (L${sliced.start}-${sliced.end}/${sliced.totalLines})\n${sliced.formatted}${more}`;
}

/**
 * Search hits with the lines around them, grouped by file. Hit lines are marked with ">".
 * This is what makes "search, then read what it found" one call instead of two.
 */
function renderHitsWithContext(workspaceRoot: string, hits: SearchHit[], context: number): string {
  const byFile = new Map<string, Set<number>>();
  for (const hit of hits) {
    const lines = byFile.get(hit.relPath) ?? new Set<number>();
    lines.add(hit.line);
    byFile.set(hit.relPath, lines);
  }

  const blocks: string[] = [];
  for (const [relPath, hitLines] of byFile) {
    let all: string[];
    try {
      const buf = fs.readFileSync(resolveSafePath(workspaceRoot, relPath).absPath);
      if (buf.length > MAX_FILE_BYTES || isBinaryBuffer(buf)) throw new Error("not text");
      all = buf.toString("utf8").split(/\r?\n/);
    } catch {
      blocks.push(`### ${relPath}\n(lines ${[...hitLines].join(", ")}; the file could not be read for context)`);
      continue;
    }
    const windows: Array<[number, number]> = [];
    for (const line of [...hitLines].sort((a, b) => a - b)) {
      const from = Math.max(1, line - context);
      const to = Math.min(all.length, line + context);
      const last = windows[windows.length - 1];
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else windows.push([from, to]);
    }
    const width = String(windows[windows.length - 1]?.[1] ?? 1).length;
    const parts = windows.map(([from, to]) => {
      const out: string[] = [];
      for (let n = from; n <= to; n++) {
        const text = all[n - 1] ?? "";
        out.push(`${hitLines.has(n) ? ">" : " "}${String(n).padStart(width, " ")} | ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
      }
      return out.join("\n");
    });
    blocks.push(`### ${relPath}\n${parts.join("\n   ...\n")}`);
  }
  return blocks.join("\n\n");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Splits text into pieces of at most `maxBytes`, on line boundaries where possible. */
function splitByBytes(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (byteLength(next) > maxBytes && current) {
      pieces.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export async function runPack(
  args: PackArgs,
  clientContext: ClientContext = {
    clientName: "default",
    maxInlineBytes: 24000,
    readToolHint: "Read",
  },
): Promise<string> {
  const raw: Record<string, unknown> = isRecord(args) ? args : {};
  const workspaceRoot = resolveWorkspaceRoot(optionalString(pick(raw, ROOT_KEYS), "pack.root"));
  const allowSecrets = optionalBoolean(raw.allow_secrets, "pack.allow_secrets") ?? false;
  const inlineOnly = optionalBoolean(raw.inline_only, "pack.inline_only") ?? false;
  const wantGitStatus = optionalBoolean(raw.git_status, "pack.git_status") ?? false;
  const literal = optionalBoolean(raw.literal, "pack.literal") ?? false;
  const query = optionalString(pick(raw, QUERY_KEYS), "pack.query")?.trim() ?? "";
  const context = Math.min(
    MAX_CONTEXT_LINES,
    Math.max(0, Math.trunc(optionalNumber(raw.context, "pack.context") ?? 0)),
  );
  const globs = optionalStringList(unwrapJson(pick(raw, GLOBS_KEYS)), "pack.globs")
    .map((g) => g.trim())
    .filter(Boolean);
  const isFile = (candidate: string): boolean => {
    try {
      return fs.statSync(resolveSafePath(workspaceRoot, candidate).absPath).isFile();
    } catch {
      return false;
    }
  };
  const specs = optionalList(unwrapJson(pick(raw, FILES_KEYS)), "pack.files").map((item, idx) =>
    parseFileSpec(item, idx, isFile),
  );
  const maxMatches = optionalNumber(raw.max_matches, "pack.max_matches");
  const maxBytes = Math.min(
    MAX_INLINE_BYTES,
    Math.max(
      MIN_INLINE_BYTES,
      Math.trunc(optionalNumber(raw.max_bytes, "pack.max_bytes") ?? clientContext.maxInlineBytes),
    ),
  );
  // An argument pack does not know is said out loud rather than dropped in silence.
  const stray = unknownWorkKeys(raw, KNOWN_PACK_KEYS);
  const strayNote =
    stray.length > 0
      ? `\n\n[Ignored unknown argument(s) ${stray.map((key) => `"${key}"`).join(", ")}: pack takes query, context, files, globs and git_status]`
      : "";

  const tasks: Array<Promise<Section>> = [];

  if (wantGitStatus) {
    tasks.push(
      runGitStatus(workspaceRoot).then((statusText) => ({
        heading: "GIT STATUS",
        body: `## GIT STATUS\n${statusText}`,
      })),
    );
  }

  if (globs.length > 0) {
    tasks.push(
      runGlobList(workspaceRoot, globs, { allowSecrets }).then((listing) => {
        const matched = listing.matched;
        const lines = matched.slice(0, MAX_GLOB_LINES).map((rel) =>
          !allowSecrets && isSecretPath(rel, workspaceRoot) ? `${rel} [secret-shielded]` : rel,
        );
        const overflow =
          matched.length > MAX_GLOB_LINES ? `\n... (+${matched.length - MAX_GLOB_LINES} more files)` : "";
        const partial = listing.note
          ? `\n[${listing.note}]`
          : listing.truncated
            ? "\n[File walk stopped at its limit; narrow the glob for a complete list]"
            : "";
        return {
          heading: `GLOBS (${matched.length} files)`,
          body: `## GLOBS (${globs.join(", ")}) — ${matched.length} files\n${lines.join("\n") || "(no matches)"}${overflow}${partial}`,
        };
      }),
    );
  }

  if (query) {
    tasks.push(
      runSearch(workspaceRoot, query, { literal, allowSecrets, maxMatches }).then((res) => {
        const notes: string[] = [];
        if (res.note) {
          notes.push(`[${res.note}]`);
        }
        if (res.redactedSecretFiles.length > 0) {
          notes.push(
            `[REDACTED SECRET MATCHES in ${res.redactedSecretFiles.join(", ")} — pass allow_secrets: true if intentional]`,
          );
        }
        if (res.truncated) {
          notes.push("[Truncated additional matches; refine query or pass max_matches]");
        }
        const tail = notes.length ? `\n${notes.join("\n")}` : "";
        if (context > 0 && res.hits.length > 0) {
          const fileCount = new Set(res.hits.map((h) => h.relPath)).size;
          return {
            heading: `SEARCH "${query}" (${res.hits.length} hits via ${res.engine})`,
            body: `## SEARCH "${query}" (${res.hits.length} hits in ${fileCount} file(s), engine=${res.engine}, ${context} line(s) of context, hits marked >)\n${renderHitsWithContext(workspaceRoot, res.hits, context)}${tail}`,
          };
        }
        const hitLines = res.hits.map((h) => `${h.relPath}:${h.line}: ${h.text}`);
        return {
          heading: `SEARCH "${query}" (${res.hits.length} hits via ${res.engine})`,
          body: `## SEARCH "${query}" (${res.hits.length} hits, engine=${res.engine})\n${
            hitLines.join("\n") || "(no matches)"
          }${tail}`,
        };
      }),
    );
  }

  if (specs.length > 0) {
    tasks.push(
      Promise.resolve().then(() => {
        const sections = specs.map((spec) => readSingleFileSection(workspaceRoot, spec, allowSecrets));
        return {
          heading: `FILES (${specs.length})`,
          body: `## FILES (${specs.length})\n${sections.join("\n\n")}`,
        };
      }),
    );
  }

  if (tasks.length === 0) {
    const walk = walkWorkspaceFiles(workspaceRoot, { maxFiles: 120, allowSecrets });
    const visible = walk.files.filter((rel) => allowSecrets || !isSecretPath(rel, workspaceRoot));
    const checks = describeChecks(detectChecks(workspaceRoot));
    return (
      [
        `## PACK OVERVIEW (${workspaceRoot})`,
        ...(checks ? [checks] : []),
        `Files (${visible.length}${walk.truncated ? "+" : ""}):`,
        visible.slice(0, 60).join("\n"),
        "",
        "Pass query, files, globs and/or git_status to gather context in this one call.",
      ].join("\n") + strayNote
    );
  }

  const sections = await Promise.all(tasks);
  const fullBody = sections.map((s) => s.body).join("\n\n");
  const fullBytes = byteLength(fullBody);

  if (inlineOnly || fullBytes <= maxBytes) {
    return fullBody + strayNote;
  }

  // Over budget. Keep as much as fits in the reply, in the order it was asked for, and move only
  // the overflow to private per-user shard files. The caller usually has what it needs already
  // and reads a shard only when it turns out to matter.
  const maxShardBytes = Math.min(40000, Math.max(8000, maxBytes));
  const inlineBudget = maxBytes - 600; // room for the footer that lists the shards
  const inlineParts: string[] = [];
  const spilled: Array<{ heading: string; paths: string[] }> = [];
  let usedBytes = 0;
  let spilling = false;

  for (const section of sections) {
    const cost = byteLength(section.body) + 2;
    if (!spilling && usedBytes + cost <= inlineBudget) {
      inlineParts.push(section.body);
      usedBytes += cost;
      continue;
    }
    spilling = true;
    spilled.push({
      heading: section.heading,
      paths: splitByBytes(section.body, maxShardBytes).map((piece) => writePrivateShard("pack", piece)),
    });
  }

  const footer = [
    `## OVERFLOW (${fullBytes} bytes total > ${maxBytes} inline cap for ${clientContext.clientName})`,
    `Not shown above — read with ${clientContext.readToolHint} only if needed:`,
    ...spilled.flatMap((item) => item.paths.map((p) => `  ${item.heading}: ${p}`)),
  ].join("\n");

  return (inlineParts.length > 0 ? `${inlineParts.join("\n\n")}\n\n${footer}` : footer) + strayNote;
}
