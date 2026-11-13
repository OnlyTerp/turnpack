import fs from "node:fs";
import { isSecretPath, resolveSafePath, resolveWorkspaceRoot, writePrivateShard } from "../security.js";
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

function parseFileSpec(item: string | PackFileSpec): PackFileSpec {
  if (typeof item !== "string") {
    return item;
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
  const safe = resolveSafePath(workspaceRoot, spec.path);
  if (!allowSecrets && isSecretPath(safe.relPath)) {
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
  if (stat.size > 2 * 1024 * 1024) {
    return `### FILE: ${safe.relPath}\n[SKIPPED: ${safe.relPath} exceeds 2 MB (${stat.size} bytes)]`;
  }

  const buf = fs.readFileSync(safe.absPath);
  if (isBinaryBuffer(buf)) {
    return `### FILE: ${safe.relPath}\n[BINARY FILE: ${safe.relPath} (${buf.length} bytes)]`;
  }

  const content = buf.toString("utf8");
  if (spec.symbol) {
    const symbols = extractSymbols(content);
    const exact = symbols.find((s) => s.name === spec.symbol);
    const partial = exact ?? symbols.find((s) => s.name.toLowerCase().includes(spec.symbol!.toLowerCase()));
    if (!partial) {
      const available = symbols.slice(0, 12).map((s) => `${s.name}:${s.startLine}`).join(", ");
      return `### SYMBOL: ${safe.relPath} :: ${spec.symbol}\n[SYMBOL NOT FOUND: available: ${available || "(none)"}]`;
    }
    const sliced = sliceLines(content, partial.startLine, partial.endLine);
    return `### SYMBOL: ${safe.relPath} :: ${partial.kind} ${partial.name} (L${sliced.start}-${sliced.end}/${sliced.totalLines})\n${sliced.formatted}`;
  }

  const sliced = sliceLines(content, spec.start_line ?? 1, spec.end_line);
  return `### FILE: ${safe.relPath} (L${sliced.start}-${sliced.end}/${sliced.totalLines})\n${sliced.formatted}`;
}

export async function runPack(
  args: PackArgs,
  clientContext: ClientContext = {
    clientName: "default",
    maxInlineBytes: 24000,
    readToolHint: "Read",
  },
): Promise<string> {
  const workspaceRoot = resolveWorkspaceRoot(args.root);
  const allowSecrets = Boolean(args.allow_secrets);
  const maxBytes = Math.min(
    44000,
    Math.max(4000, args.max_bytes ?? clientContext.maxInlineBytes),
  );

  const tasks: Array<Promise<{ heading: string; body: string }>> = [];

  if (args.git_status) {
    tasks.push(
      runGitStatus(workspaceRoot).then((statusText) => ({
        heading: "GIT STATUS",
        body: `## GIT STATUS\n${statusText}`,
      })),
    );
  }

  if (args.globs && args.globs.length > 0) {
    const globs = args.globs;
    tasks.push(
      Promise.resolve().then(() => {
        const walk = walkWorkspaceFiles(workspaceRoot, { allowSecrets });
        const matchers = globs.map(globToRegExp);
        const matched = walk.files.filter((rel) => matchers.some((rx) => rx.test(rel)));
        const lines = matched.slice(0, 200).map((rel) =>
          !allowSecrets && isSecretPath(rel) ? `${rel} [secret-shielded]` : rel,
        );
        const overflow = matched.length > 200 ? `\n... (+${matched.length - 200} more files)` : "";
        return {
          heading: `GLOBS (${matched.length} files)`,
          body: `## GLOBS (${globs.join(", ")}) — ${matched.length} files\n${lines.join("\n") || "(no matches)"}${overflow}`,
        };
      }),
    );
  }

  if (args.query && args.query.trim()) {
    const q = args.query.trim();
    tasks.push(
      runSearch(workspaceRoot, q, {
        literal: args.literal,
        allowSecrets,
        maxMatches: args.max_matches,
      }).then((res) => {
        const hitLines = res.hits.map((h) => `${h.relPath}:${h.line}: ${h.text}`);
        const notes: string[] = [];
        if (res.redactedSecretFiles.length > 0) {
          notes.push(
            `[REDACTED SECRET MATCHES in ${res.redactedSecretFiles.join(", ")} — pass allow_secrets: true if intentional]`,
          );
        }
        if (res.truncated) {
          notes.push("[Truncated additional matches; refine query or pass max_matches]");
        }
        return {
          heading: `SEARCH "${q}" (${res.hits.length} hits via ${res.engine})`,
          body: `## SEARCH "${q}" (${res.hits.length} hits, engine=${res.engine})\n${
            hitLines.join("\n") || "(no matches)"
          }${notes.length ? `\n${notes.join("\n")}` : ""}`,
        };
      }),
    );
  }

  if (args.files && args.files.length > 0) {
    const specs = args.files.map(parseFileSpec);
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
    return `## PACK OVERVIEW (${workspaceRoot})\nFiles (${walk.files.length}${walk.truncated ? "+" : ""}):\n${walk.files.slice(0, 60).join("\n")}`;
  }

  const sections = await Promise.all(tasks);
  const fullBody = sections.map((s) => s.body).join("\n\n");

  if (args.inline_only || Buffer.byteLength(fullBody, "utf8") <= maxBytes) {
    return fullBody;
  }

  // Spill large bundles to private per-user shard files so client context stays bounded.
  const maxShardBytes = Math.min(40000, Math.max(8000, maxBytes));
  const shardPaths: string[] = [];
  let currentChunk = "";

  for (const section of sections) {
    const candidate = currentChunk ? `${currentChunk}\n\n${section.body}` : section.body;
    if (Buffer.byteLength(candidate, "utf8") <= maxShardBytes) {
      currentChunk = candidate;
      continue;
    }
    if (currentChunk) {
      shardPaths.push(writePrivateShard("pack", currentChunk));
      currentChunk = "";
    }
    if (Buffer.byteLength(section.body, "utf8") <= maxShardBytes) {
      currentChunk = section.body;
    } else {
      const lines = section.body.split("\n");
      let slice = "";
      for (const line of lines) {
        const nextSlice = slice ? `${slice}\n${line}` : line;
        if (Buffer.byteLength(nextSlice, "utf8") > maxShardBytes && slice) {
          shardPaths.push(writePrivateShard("pack", slice));
          slice = line;
        } else {
          slice = nextSlice;
        }
      }
      if (slice) {
        shardPaths.push(writePrivateShard("pack", slice));
      }
    }
  }
  if (currentChunk) {
    shardPaths.push(writePrivateShard("pack", currentChunk));
  }

  const summary = [
    `PACK COMPILED (${Buffer.byteLength(fullBody, "utf8")} bytes > ${maxBytes} inline cap for ${clientContext.clientName})`,
    `Sections: ${sections.map((s) => s.heading).join(" | ")}`,
    `Read shards in parallel with ${clientContext.readToolHint}:`,
    ...shardPaths.map((p, idx) => `  [${idx + 1}] ${p}`),
  ];
  return summary.join("\n");
}
