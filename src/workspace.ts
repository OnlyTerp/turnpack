import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { isSecretPath, resolveSafePath } from "./security.js";

const execFileAsync = promisify(execFile);

/** Directories that are never source: VCS internals, dependency trees, build output, caches. */
export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

export interface SymbolOutline {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface SearchHit {
  relPath: string;
  line: number;
  text: string;
}

export interface SearchOutput {
  hits: SearchHit[];
  redactedSecretFiles: string[];
  truncated: boolean;
  engine: "rg" | "node";
  /** Set when the pattern could not be used as written (for example an invalid regex). */
  note?: string;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i] ?? "";
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const closeIdx = normalized.indexOf("}", i);
      if (closeIdx !== -1) {
        const group = normalized
          .slice(i + 1, closeIdx)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${group.join("|")})`;
        i = closeIdx + 1;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  out += "$";
  return new RegExp(out, process.platform === "win32" ? "i" : "");
}

export function walkWorkspaceFiles(
  workspaceRoot: string,
  options: { maxFiles?: number; allowSecrets?: boolean } = {},
): { files: string[]; secretFiles: string[]; truncated: boolean } {
  const maxFiles = options.maxFiles ?? 2500;
  const allowSecrets = options.allowSecrets ?? false;
  const files: string[] = [];
  const secretFiles: string[] = [];
  let truncated = false;
  const visitedDirs = new Set<string>();
  const seenFiles = new Set<string>();

  function visit(dirAbs: string): void {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let realDir: string;
    try {
      realDir = fs.realpathSync(dirAbs);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (SKIP_DIRS.has(entry.name)) continue;

      const candidate = path.join(dirAbs, entry.name);
      let safe: { absPath: string; relPath: string };
      try {
        safe = resolveSafePath(workspaceRoot, candidate);
      } catch {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(safe.absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        visit(safe.absPath);
      } else if (stat.isFile()) {
        // A symlinked file is reported under its real path, which may already be listed.
        if (seenFiles.has(safe.relPath)) continue;
        seenFiles.add(safe.relPath);
        if (!allowSecrets && isSecretPath(safe.relPath, workspaceRoot)) {
          secretFiles.push(safe.relPath);
        }
        files.push(safe.relPath);
      }
    }
  }

  visit(workspaceRoot);
  return { files, secretFiles, truncated };
}

/** Edit distance between two short names, given up on once it passes `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length] ?? limit + 1;
}

/** For a path that does not exist: up to three files in the workspace it was probably meant to be. */
export function suggestPaths(workspaceRoot: string, relPath: string): string {
  const wanted = relPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const stem = wanted.replace(/\.[^.]+$/, "");
  if (!stem) return "";
  let files: string[];
  try {
    files = walkWorkspaceFiles(workspaceRoot, { maxFiles: 5000 }).files;
  } catch {
    return "";
  }
  const ranked = files
    .map((rel) => {
      const base = rel.split("/").pop()?.toLowerCase() ?? "";
      const baseStem = base.replace(/\.[^.]+$/, "");
      // The same name elsewhere, the same name with another extension, a near-miss spelling.
      const score =
        base === wanted
          ? 4
          : baseStem === stem
            ? 3
            : stem.length >= 4 && baseStem.length <= 40 && editDistance(baseStem, stem, 2) <= 2
              ? 2
              : stem.length >= 4 && base.includes(stem)
                ? 1
                : 0;
      return { rel, score };
    })
    .filter((entry) => entry.score > 0 && !isSecretPath(entry.rel, workspaceRoot))
    .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
    .slice(0, 3);
  return ranked.length > 0 ? ` Did you mean ${ranked.map((entry) => `"${entry.rel}"`).join(" or ")}?` : "";
}

const MAX_HIT_TEXT = 260;

function parseRgOutput(
  stdout: string,
  workspaceRoot: string,
  allowSecrets: boolean,
  maxMatches: number,
): { hits: SearchHit[]; redactedSecretFiles: string[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  const redactedSet = new Set<string>();
  let truncated = false;

  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    // `--null` puts a NUL between the path and "line:text", so paths that themselves contain
    // ":<digits>:" cannot be mis-split.
    const nul = rawLine.indexOf("\0");
    if (nul === -1) continue;
    const rest = /^(\d+):(.*)$/s.exec(rawLine.slice(nul + 1));
    if (!rest) continue;
    const relPath = rawLine.slice(0, nul).replace(/\\/g, "/").replace(/^\.\//, "");
    const lineNum = Number(rest[1] ?? "0");
    const text = (rest[2] ?? "").replace(/\r$/, "").slice(0, MAX_HIT_TEXT);
    if (!allowSecrets && isSecretPath(relPath, workspaceRoot)) {
      redactedSet.add(relPath);
      continue;
    }
    if (hits.length >= maxMatches) {
      truncated = true;
      break;
    }
    hits.push({ relPath, line: lineNum, text });
  }

  return { hits, redactedSecretFiles: [...redactedSet], truncated };
}

interface ExecFailure {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

export async function runSearch(
  workspaceRoot: string,
  pattern: string,
  options: { literal?: boolean; allowSecrets?: boolean; maxMatches?: number; budgetMs?: number } = {},
): Promise<SearchOutput> {
  const allowSecrets = options.allowSecrets ?? false;
  const maxMatches = Math.min(Math.max(Math.trunc(options.maxMatches ?? 80) || 80, 1), 300);

  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--null",
    "--hidden",
    "--no-config",
    "--no-require-git",
    "--max-columns",
    "400",
    "--max-columns-preview",
    "--max-filesize",
    "1M",
  ];
  // ripgrep already honours .gitignore, so only the directories that are noise in every repo
  // are excluded outright; SKIP_DIRS (a heuristic) is reserved for the gitignore-blind walker.
  for (const dir of [".git", ".hg", ".svn", "node_modules"]) {
    rgArgs.push("--glob", `!**/${dir}/**`);
  }
  if (options.literal) {
    rgArgs.push("--fixed-strings");
  }
  // `-e` plus `--` pin the pattern and the path as data. Without them a query that starts with
  // "-" (a search for "--verbose", or a deliberate "--pre=...") is read by ripgrep as a flag.
  rgArgs.push("-e", pattern, "--", ".");

  let rgNote: string | undefined;
  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      cwd: workspaceRoot,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10000,
      windowsHide: true,
    });
    return { ...parseRgOutput(stdout, workspaceRoot, allowSecrets, maxMatches), engine: "rg" };
  } catch (err) {
    const failure = err as ExecFailure;
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    if (failure.code === 1) {
      return { hits: [], redactedSecretFiles: [], truncated: false, engine: "rg" };
    }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      // More output than we buffer: keep the complete lines we did get and say so.
      const complete = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
      return { ...parseRgOutput(complete, workspaceRoot, allowSecrets, maxMatches), truncated: true, engine: "rg" };
    }
    if (typeof failure.code === "number" && stdout) {
      // Exit 2 with matches: some files were unreadable, the rest of the result is still valid.
      return { ...parseRgOutput(stdout, workspaceRoot, allowSecrets, maxMatches), engine: "rg" };
    }
    if (failure.code === 2 && typeof failure.stderr === "string" && /regex parse error/i.test(failure.stderr)) {
      rgNote = "ripgrep rejected the regex; used the JavaScript regex engine instead";
    }
    // Anything else (ripgrep missing, timeout): fall through to the built-in search.
  }

  if (!options.literal) {
    try {
      new RegExp(pattern);
    } catch (reErr) {
      return {
        hits: [],
        redactedSecretFiles: [],
        truncated: false,
        engine: "node",
        note: `invalid regex (${reErr instanceof Error ? reErr.message : String(reErr)}); fix the pattern or pass literal: true`,
      };
    }
  }

  const budgetMs = options.budgetMs ?? PATTERN_BUDGET_MS;
  const result = await runPatternJob<SearchOutput>(
    { op: "search", workspaceRoot, pattern, literal: Boolean(options.literal), allowSecrets, maxMatches },
    budgetMs,
    (reason) => ({
      hits: [],
      redactedSecretFiles: [],
      truncated: true,
      engine: "node",
      note:
        reason === "timeout"
          ? `search stopped after ${budgetMs}ms: this pattern is too expensive for the built-in regex engine; simplify it or pass literal: true`
          : `built-in search failed (${reason})`,
    }),
  );
  return rgNote && !result.note ? { ...result, note: rgNote } : result;
}

/**
 * Patterns come from the model, and the built-in engines (JavaScript RegExp for search, a
 * regex compiled from each glob for listings) can take exponential time on a hostile or merely
 * unlucky pattern. Run in the server's own thread, one such call would freeze every other
 * request. So pattern work runs in a worker thread with a deadline, and is abandoned at it.
 */
const PATTERN_BUDGET_MS = 5000;

export type PatternJob =
  | {
      op: "search";
      workspaceRoot: string;
      pattern: string;
      literal: boolean;
      allowSecrets: boolean;
      maxMatches: number;
    }
  | { op: "glob"; workspaceRoot: string; globs: string[]; allowSecrets: boolean };

export interface GlobListing {
  matched: string[];
  truncated: boolean;
  note?: string;
}

function runPatternJob<T>(job: PatternJob, budgetMs: number, onFailure: (reason: string) => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(onFailure("timeout")), budgetMs);
    try {
      worker = new Worker(new URL("./search-worker.js", import.meta.url), { workerData: job });
    } catch (err) {
      finish(onFailure(err instanceof Error ? err.message : String(err)));
      return;
    }
    worker.once("message", (value: T) => finish(value));
    worker.once("error", (err) => finish(onFailure(err.message)));
    worker.once("exit", () => finish(onFailure("worker exited early")));
  });
}

/** Lists workspace files matching any of the globs, within the pattern time budget. */
export function runGlobList(
  workspaceRoot: string,
  globs: string[],
  options: { allowSecrets?: boolean; budgetMs?: number } = {},
): Promise<GlobListing> {
  const budgetMs = options.budgetMs ?? PATTERN_BUDGET_MS;
  return runPatternJob<GlobListing>(
    { op: "glob", workspaceRoot, globs, allowSecrets: options.allowSecrets ?? false },
    budgetMs,
    (reason) => ({
      matched: [],
      truncated: true,
      note:
        reason === "timeout"
          ? `glob listing stopped after ${budgetMs}ms: use fewer wildcards`
          : `glob listing failed (${reason})`,
    }),
  );
}

/** Worker-side half of runSearch's fallback. Synchronous, and only ever called off the main thread. */
export function searchWithNodeEngine(job: Extract<PatternJob, { op: "search" }>): SearchOutput {
  const { workspaceRoot, pattern, literal, allowSecrets, maxMatches } = job;
  const regex = literal ? null : new RegExp(pattern);
  const { files } = walkWorkspaceFiles(workspaceRoot, { maxFiles: 1500, allowSecrets });
  const hits: SearchHit[] = [];
  const redactedSet = new Set<string>();
  let truncated = false;

  outer: for (const relPath of files) {
    const secret = !allowSecrets && isSecretPath(relPath, workspaceRoot);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(workspaceRoot, relPath));
    } catch {
      continue;
    }
    if (buf.length > 1024 * 1024 || isBinaryBuffer(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      const matched = regex ? regex.test(lineText) : lineText.includes(pattern);
      if (!matched) continue;
      if (secret) {
        redactedSet.add(relPath);
        continue outer;
      }
      if (hits.length >= maxMatches) {
        truncated = true;
        break outer;
      }
      hits.push({ relPath, line: i + 1, text: lineText.slice(0, MAX_HIT_TEXT) });
    }
  }

  return { hits, redactedSecretFiles: [...redactedSet], truncated, engine: "node" };
}

/** Worker-side half of runGlobList. */
export function listGlobMatches(job: Extract<PatternJob, { op: "glob" }>): GlobListing {
  const walk = walkWorkspaceFiles(job.workspaceRoot, { allowSecrets: job.allowSecrets });
  const matchers = job.globs.map(globToRegExp);
  return {
    matched: walk.files.filter((rel) => matchers.some((rx) => rx.test(rel))),
    truncated: walk.truncated,
  };
}

export function extractSymbols(content: string): SymbolOutline[] {
  const lines = content.split(/\r?\n/);
  const symbols: SymbolOutline[] = [];

  const jsDecl =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  const pyDecl = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)\b/;
  const rustDecl = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z_][\w]*)/;
  const goDecl = /^(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*[(\[]/;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    let kind: string | undefined;
    let name: string | undefined;
    let isPython = false;
    let pyIndent = 0;

    const jm = jsDecl.exec(trimmed);
    if (jm) {
      if (jm[1] && jm[2]) {
        kind = jm[1].replace("*", "");
        name = jm[2];
      } else if (jm[3]) {
        kind = "function";
        name = jm[3];
      }
    } else {
      const rm = rustDecl.exec(trimmed) ?? goDecl.exec(trimmed);
      if (rm && rm[1] && rm[2]) {
        kind = rm[1];
        name = rm[2];
      } else {
        const pm = pyDecl.exec(raw);
        if (pm && pm[2] && pm[3]) {
          kind = pm[2];
          name = pm[3];
          isPython = true;
          pyIndent = (pm[1] ?? "").length;
        }
      }
    }

    if (!kind || !name) continue;

    let endLine = idx + 1;
    if (isPython) {
      for (let j = idx + 1; j < lines.length; j++) {
        const nextLine = lines[j] ?? "";
        if (!nextLine.trim()) continue;
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent <= pyIndent) break;
        endLine = j + 1;
      }
    } else {
      let depth = 0;
      let sawBrace = false;
      const limit = Math.min(lines.length, idx + 350);
      for (let j = idx; j < limit; j++) {
        const scan = lines[j] ?? "";
        for (let k = 0; k < scan.length; k++) {
          const ch = scan[k];
          if (ch === "{") {
            depth += 1;
            sawBrace = true;
          } else if (ch === "}") {
            depth -= 1;
          }
        }
        endLine = j + 1;
        if (sawBrace && depth <= 0) break;
        if (!sawBrace && scan.includes(";")) break;
      }
    }

    symbols.push({ name, kind, startLine: idx + 1, endLine });
  }

  return symbols;
}

export function sliceLines(content: string, startLine = 1, endLine?: number): {
  formatted: string;
  start: number;
  end: number;
  totalLines: number;
} {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Math.max(1, Math.min(startLine, totalLines));
  const effectiveEnd = Math.max(start, Math.min(endLine ?? Math.min(totalLines, start + 199), totalLines));
  const width = String(effectiveEnd).length;
  const out: string[] = [];
  for (let ln = start; ln <= effectiveEnd; ln++) {
    const text = lines[ln - 1] ?? "";
    out.push(`${String(ln).padStart(width, " ")} | ${text}`);
  }
  return { formatted: out.join("\n"), start, end: effectiveEnd, totalLines };
}

export async function runGitStatus(workspaceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspaceRoot,
      timeout: 5000,
    });
    return stdout.trim() || "(clean working tree)";
  } catch (err) {
    return `(git status unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}
