import { spawn } from "node:child_process";
import fs from "node:fs";
import vm from "node:vm";
import { isSecretPath, resolveSafePath, resolveWorkspaceRoot } from "../security.js";
import {
  extractSymbols,
  globToRegExp,
  isBinaryBuffer,
  runGitStatus,
  runSearch,
  walkWorkspaceFiles,
  type SearchHit,
  type SymbolOutline,
} from "../workspace.js";

export interface BatchArgs {
  cwd?: string;
  code: string;
  timeout_ms?: number;
  allow_secrets?: boolean;
}

export interface BatchCtx {
  files: (glob?: string) => string[];
  read: (relPath: string, startLine?: number, endLine?: number) => string;
  grep: (
    pattern: string,
    opts?: { literal?: boolean; maxMatches?: number },
  ) => Promise<SearchHit[]>;
  outline: (relPath: string) => SymbolOutline[];
  gitStatus: () => Promise<string>;
  exec: (command: string) => Promise<{ stdout: string; stderr: string }>;
}

function buildWrappedScript(rawCode: string): string {
  const trimmed = rawCode.trim();
  const isFunction = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^async\s+function\b|^function\b/.test(
    trimmed,
  );
  if (isFunction) {
    return `(async () => { const __fn = (${trimmed}); return await __fn(ctx); })()`;
  }
  return `(async () => {\n${rawCode}\n})()`;
}

export async function runBatch(args: BatchArgs): Promise<string> {
  const t0 = performance.now();
  const workspaceRoot = resolveWorkspaceRoot(args.cwd);
  const allowSecrets = Boolean(args.allow_secrets);
  const timeoutMs = Math.min(30000, Math.max(250, args.timeout_ms ?? 5000));
  const logs: string[] = [];

  const ctx: BatchCtx = {
    files(glob?: string): string[] {
      const walk = walkWorkspaceFiles(workspaceRoot, { allowSecrets });
      const visible = allowSecrets
        ? walk.files
        : walk.files.filter((rel) => !isSecretPath(rel));
      if (!glob || !glob.trim()) return visible;
      const rx = globToRegExp(glob.trim());
      return visible.filter((rel) => rx.test(rel));
    },

    read(relPath: string, startLine?: number, endLine?: number): string {
      const safe = resolveSafePath(workspaceRoot, relPath);
      if (!allowSecrets && isSecretPath(safe.relPath)) {
        return `[REDACTED SECRET FILE: ${safe.relPath}]`;
      }
      const buf = fs.readFileSync(safe.absPath);
      if (isBinaryBuffer(buf)) {
        return `[BINARY FILE: ${safe.relPath}]`;
      }
      const text = buf.toString("utf8");
      if (startLine === undefined && endLine === undefined) {
        return text;
      }
      const lines = text.split(/\r?\n/);
      const s = Math.max(1, startLine ?? 1);
      const e = Math.min(lines.length, endLine ?? lines.length);
      return lines.slice(s - 1, e).join("\n");
    },

    async grep(
      pattern: string,
      opts: { literal?: boolean; maxMatches?: number } = {},
    ): Promise<SearchHit[]> {
      const res = await runSearch(workspaceRoot, pattern, {
        literal: opts.literal,
        allowSecrets,
        maxMatches: opts.maxMatches ?? 80,
      });
      return res.hits;
    },

    outline(relPath: string): SymbolOutline[] {
      const safe = resolveSafePath(workspaceRoot, relPath);
      if (!allowSecrets && isSecretPath(safe.relPath)) {
        return [];
      }
      const content = fs.readFileSync(safe.absPath, "utf8");
      return extractSymbols(content);
    },

    gitStatus(): Promise<string> {
      return runGitStatus(workspaceRoot);
    },

    async exec(command: string): Promise<{ stdout: string; stderr: string }> {
      if (process.env.TURNPACK_ALLOW_EXEC !== "1") {
        throw new Error(
          "ERR_EXEC_DISABLED: batch is read-only by default. Set TURNPACK_ALLOW_EXEC=1 to enable local command execution.",
        );
      }
      return await new Promise((resolveExec, rejectExec) => {
        const child = spawn(command, {
          cwd: workspaceRoot,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          rejectExec(new Error(`batch exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.length < 262144) stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 262144) stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectExec(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolveExec({ stdout, stderr });
          } else {
            rejectExec(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
          }
        });
      });
    },
  };

  const sandbox = vm.createContext({
    ctx,
    console: {
      log: (...items: unknown[]) => {
        logs.push(items.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      },
    },
  });

  const wrapped = buildWrappedScript(args.code);
  const script = new vm.Script(wrapped);
  const promise = script.runInContext(sandbox, { timeout: timeoutMs }) as Promise<unknown>;

  const result = await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`batch timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  const elapsedMs = Math.round(performance.now() - t0);
  const formattedResult =
    result === undefined
      ? "(undefined)"
      : typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);

  const parts = [`BATCH OK (${elapsedMs}ms)`];
  if (logs.length > 0) {
    parts.push(`Logs:\n${logs.join("\n")}`);
  }
  parts.push(`Result:\n${formattedResult}`);
  return parts.join("\n\n");
}
