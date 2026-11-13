import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInsideDir } from "./security.js";

/**
 * The set of directories a server instance is allowed to work in.
 *
 * Tool calls carry a `root` / `cwd` argument, and that argument is written by the model. If it
 * were trusted as-is, the "workspace jail" would be wherever the model said it was. So the
 * boundary is fixed on the server side, from one of three sources in priority order:
 *
 *   1. `TURNPACK_ROOT` — explicit choice by whoever configured the server.
 *   2. MCP `roots` — the folders the client says this session is working on.
 *   3. `CLAUDE_PROJECT_DIR` — set by Claude Code for the servers it launches, because it makes
 *      no promise about the working directory it starts them in.
 *   4. The directory the server was started in.
 *
 * A tool argument may then pick a directory inside that boundary, never outside it.
 */
export interface RootPolicy {
  roots: string[];
  source: "env" | "client" | "project" | "cwd";
}

function realDirOrNull(candidate: string): string | null {
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function createRootPolicy(cwd: string = process.cwd()): RootPolicy {
  const fromEnv = process.env.TURNPACK_ROOT?.trim();
  if (fromEnv) {
    const roots = fromEnv
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => realDirOrNull(path.resolve(cwd, entry)))
      .filter((entry): entry is string => entry !== null);
    if (roots.length === 0) {
      throw new Error(`TURNPACK_ROOT="${fromEnv}" does not name an existing directory`);
    }
    return { roots: [...new Set(roots)], source: "env" };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (projectDir) {
    const real = realDirOrNull(projectDir);
    if (real) return { roots: [real], source: "project" };
  }
  return { roots: [fs.realpathSync(cwd)], source: "cwd" };
}

/**
 * Applies the folders reported by an MCP client (`roots/list`). An explicit `TURNPACK_ROOT`
 * always wins, and an empty or unusable list leaves the current policy untouched.
 */
export function applyClientRoots(policy: RootPolicy, uris: unknown): RootPolicy {
  if (policy.source === "env" || !Array.isArray(uris)) return policy;
  const roots: string[] = [];
  for (const item of uris) {
    const uri = (item as { uri?: unknown } | null)?.uri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    let fsPath: string;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      continue;
    }
    const real = realDirOrNull(fsPath);
    if (real) roots.push(real);
  }
  if (roots.length === 0) return policy;
  return { roots: [...new Set(roots)], source: "client" };
}

/**
 * Turns the model-supplied `root` / `cwd` argument into a directory that is guaranteed to sit
 * inside the policy. No argument means the primary root. Relative arguments are resolved
 * against the primary root.
 */
export function resolveToolRoot(policy: RootPolicy, requested?: unknown): string {
  const primary = policy.roots[0];
  if (!primary) {
    throw new Error("ERR_NO_WORKSPACE_ROOT: server has no workspace root configured");
  }
  if (requested === undefined || requested === null) return primary;
  if (typeof requested !== "string") {
    throw new Error("root/cwd must be a string path");
  }
  const trimmed = requested.trim();
  if (!trimmed || trimmed === ".") return primary;

  const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(primary, trimmed);
  const real = realDirOrNull(candidate);
  if (real && policy.roots.some((root) => isInsideDir(root, real))) {
    return real;
  }
  // The same message whether the directory is missing or merely off-limits, so the answer
  // cannot be used to probe what exists outside the workspace.
  throw new Error(
    `ERR_ROOT_OUTSIDE_WORKSPACE: "${requested}" is not a directory inside this server's workspace (${policy.roots.join(", ")}). ` +
      "Omit root/cwd to use the workspace, or start the server there (or set TURNPACK_ROOT).",
  );
}
