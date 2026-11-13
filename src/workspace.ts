import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
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
  options: { literal?: boolean; allowSecrets?: boolean; maxMatches?: number } = {},
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

  let regex: RegExp | null = null;
  if (!options.literal) {
    try {
      regex = new RegExp(pattern);
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

  return {
    hits,
    redactedSecretFiles: [...redactedSet],
    truncated,
    engine: "node",
    ...(rgNote ? { note: rgNote } : {}),
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
