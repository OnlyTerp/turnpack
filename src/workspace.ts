import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isSecretPath, resolveSafePath } from "./security.js";

const execFileAsync = promisify(execFile);

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  ".venv",
  "__pycache__",
  "coverage",
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
        if (!allowSecrets && isSecretPath(safe.relPath)) {
          secretFiles.push(safe.relPath);
        }
        files.push(safe.relPath);
      }
    }
  }

  visit(workspaceRoot);
  return { files, secretFiles, truncated };
}

function parseRgLines(
  stdout: string,
  allowSecrets: boolean,
  maxMatches: number,
): { hits: SearchHit[]; redactedSecretFiles: string[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  const redactedSet = new Set<string>();
  let truncated = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(rawLine);
    if (!match) continue;
    const relPath = (match[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const lineNum = Number(match[2] ?? "0");
    const text = (match[3] ?? "").slice(0, 260);
    if (!allowSecrets && isSecretPath(relPath)) {
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

export async function runSearch(
  workspaceRoot: string,
  pattern: string,
  options: { literal?: boolean; allowSecrets?: boolean; maxMatches?: number } = {},
): Promise<SearchOutput> {
  const allowSecrets = options.allowSecrets ?? false;
  const maxMatches = Math.min(Math.max(options.maxMatches ?? 80, 1), 300);

  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
  ];
  if (options.literal) {
    rgArgs.push("-F");
  }
  rgArgs.push(pattern, ".");

  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      cwd: workspaceRoot,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10000,
    });
    const parsed = parseRgLines(stdout, allowSecrets, maxMatches);
    return { ...parsed, engine: "rg" };
  } catch (err) {
    const code = (err as { code?: number | string; stdout?: string }).code;
    const stdout = (err as { stdout?: string }).stdout ?? "";
    if (code === 1) {
      return { hits: [], redactedSecretFiles: [], truncated: false, engine: "rg" };
    }
    if (typeof code === "number" && stdout) {
      const parsed = parseRgLines(stdout, allowSecrets, maxMatches);
      return { ...parsed, engine: "rg" };
    }
  }

  // Pure-Node fallback when ripgrep is unavailable.
  const regex = options.literal
    ? null
    : (() => {
        try {
          return new RegExp(pattern);
        } catch {
          return null;
        }
      })();
  const { files } = walkWorkspaceFiles(workspaceRoot, { maxFiles: 1500, allowSecrets });
  const hits: SearchHit[] = [];
  const redactedSet = new Set<string>();
  let truncated = false;

  for (const relPath of files) {
    if (!allowSecrets && isSecretPath(relPath)) {
      redactedSet.add(relPath);
      continue;
    }
    const { absPath } = resolveSafePath(workspaceRoot, relPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      continue;
    }
    if (buf.length > 1024 * 1024 || isBinaryBuffer(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      const matched = regex ? regex.test(lineText) : lineText.includes(pattern);
      if (matched) {
        if (hits.length >= maxMatches) {
          truncated = true;
          return { hits, redactedSecretFiles: [...redactedSet], truncated, engine: "node" };
        }
        hits.push({ relPath, line: i + 1, text: lineText.slice(0, 260) });
      }
    }
  }

  return { hits, redactedSecretFiles: [...redactedSet], truncated, engine: "node" };
}

export function extractSymbols(content: string): SymbolOutline[] {
  const lines = content.split(/\r?\n/);
  const symbols: SymbolOutline[] = [];

  const jsDecl =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  const pyDecl = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)\b/;
  const rustDecl = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z_][\w]*)/;

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
      const rm = rustDecl.exec(trimmed);
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
