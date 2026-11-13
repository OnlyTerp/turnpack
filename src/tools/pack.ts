import fs from "node:fs";
import { isSecretPath, resolveSafePath, resolveWorkspaceRoot, writePrivateShard } from "../security.js";
import {
  isRecord,
  optionalBoolean,
  optionalList,
  optionalNumber,
  optionalString,
  optionalStringList,
} from "../validate.js";
import {
  extractSymbols,
  globToRegExp,
  isBinaryBuffer,
  runGitStatus,
  runSearch,
  sliceLines,
  walkWorkspaceFiles,
} from "../workspace.js";

export interface PackFileSpec {
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
}

export interface PackArgs {
  root?: string;
  query?: string;
  literal?: boolean;
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

function parseFileSpec(item: unknown, idx: number): PackFileSpec {
  if (isRecord(item)) {
    const filePath = item.path;
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error(`pack.files[${idx}].path must be a non-empty string`);
    }
    return {
      path: filePath,
      start_line: optionalNumber(item.start_line, `pack.files[${idx}].start_line`),
      end_line: optionalNumber(item.end_line, `pack.files[${idx}].end_line`),
      symbol: optionalString(item.symbol, `pack.files[${idx}].symbol`),
    };
  }
  if (typeof item !== "string" || !item.trim()) {
    throw new Error(`pack.files[${idx}] must be a path string or a {path, ...} object`);
  }
  const rangeMatch = /^(.+):(\d+)-(\d+)$/.exec(item);
  if (rangeMatch && rangeMatch[1]) {
    return {
      path: rangeMatch[1],
      start_line: Number(rangeMatch[2]),
      end_line: Number(rangeMatch[3]),
    };
  }
  const singleMatch = /^(.+):(\d+)$/.exec(item);
  if (singleMatch && singleMatch[1]) {
    const line = Number(singleMatch[2]);
    return { path: singleMatch[1], start_line: Math.max(1, line - 20), end_line: line + 60 };
  }
  return { path: item };
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
    return `### FILE: ${safe.relPath}\n[NOT FOUND: ${safe.relPath}]`;
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
  const more =
    spec.end_line === undefined && sliced.end < sliced.totalLines
      ? `\n[... ${sliced.totalLines - sliced.end} more lines; request "${safe.relPath}:${sliced.end + 1}-${sliced.totalLines}" for the rest]`
      : "";
  return `### FILE: ${safe.relPath} (L${sliced.start}-${sliced.end}/${sliced.totalLines})\n${sliced.formatted}${more}`;
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
  const workspaceRoot = resolveWorkspaceRoot(optionalString(raw.root, "pack.root"));
  const allowSecrets = optionalBoolean(raw.allow_secrets, "pack.allow_secrets") ?? false;
  const inlineOnly = optionalBoolean(raw.inline_only, "pack.inline_only") ?? false;
  const wantGitStatus = optionalBoolean(raw.git_status, "pack.git_status") ?? false;
  const literal = optionalBoolean(raw.literal, "pack.literal") ?? false;
  const query = optionalString(raw.query, "pack.query")?.trim() ?? "";
  const globs = optionalStringList(raw.globs, "pack.globs").map((g) => g.trim()).filter(Boolean);
  const specs = optionalList(raw.files, "pack.files").map(parseFileSpec);
  const maxMatches = optionalNumber(raw.max_matches, "pack.max_matches");
  const maxBytes = Math.min(
    MAX_INLINE_BYTES,
    Math.max(
      MIN_INLINE_BYTES,
      Math.trunc(optionalNumber(raw.max_bytes, "pack.max_bytes") ?? clientContext.maxInlineBytes),
    ),
  );

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
      Promise.resolve().then(() => {
        const walk = walkWorkspaceFiles(workspaceRoot, { allowSecrets });
        const matchers = globs.map(globToRegExp);
        const matched = walk.files.filter((rel) => matchers.some((rx) => rx.test(rel)));
        const lines = matched.slice(0, MAX_GLOB_LINES).map((rel) =>
          !allowSecrets && isSecretPath(rel, workspaceRoot) ? `${rel} [secret-shielded]` : rel,
        );
        const overflow =
          matched.length > MAX_GLOB_LINES ? `\n... (+${matched.length - MAX_GLOB_LINES} more files)` : "";
        const partial = walk.truncated ? "\n[File walk stopped at its limit; narrow the glob for a complete list]" : "";
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
        const hitLines = res.hits.map((h) => `${h.relPath}:${h.line}: ${h.text}`);
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
        return {
          heading: `SEARCH "${query}" (${res.hits.length} hits via ${res.engine})`,
          body: `## SEARCH "${query}" (${res.hits.length} hits, engine=${res.engine})\n${
            hitLines.join("\n") || "(no matches)"
          }${notes.length ? `\n${notes.join("\n")}` : ""}`,
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
    return [
      `## PACK OVERVIEW (${workspaceRoot})`,
      `Files (${visible.length}${walk.truncated ? "+" : ""}):`,
      visible.slice(0, 60).join("\n"),
      "",
      "Pass query, files, globs and/or git_status to gather context in this one call.",
    ].join("\n");
  }

  const sections = await Promise.all(tasks);
  const fullBody = sections.map((s) => s.body).join("\n\n");
  const fullBytes = byteLength(fullBody);

  if (inlineOnly || fullBytes <= maxBytes) {
    return fullBody;
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

  return inlineParts.length > 0 ? `${inlineParts.join("\n\n")}\n\n${footer}` : footer;
}
